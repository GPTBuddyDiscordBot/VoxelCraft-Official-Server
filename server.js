// VoxelCraft Multiplayer Server
// ----------------------------------
// A lightweight Node.js WebSocket server that lets you host your own
// VoxelCraft world. All players are equal (NO owner concept) — survival only.
//
// Features:
//   • Player join / leave with username + Minecraft username (for skins)
//   • Position relay (clients interpolate between snapshots for smooth motion)
//   • Block change relay (last-write-wins; spawn-radius protected if enabled)
//   • Chat relay
//   • Optional mod-state sync (sharks / skateboard / etc.)
//   • HTTP GET /status endpoint for the server browser
//   • Customizable via config.json (port, maxPlayers, motd, worldSeed, pvp, spawnProtection, allowCommands)
//
// Requires Node.js 18+ and the `ws` package (install via `npm install`).

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

// ---------- Load config ----------
const CONFIG_PATH = path.join(__dirname, 'config.json');
function loadConfig() {
  const defaults = {
    port: 3001,
    maxPlayers: 20,
    motd: 'My VoxelCraft Server',
    worldSeed: 'my-server',
    pvp: true,
    spawnProtection: true,
    allowCommands: false,
    mods: { sharks: false, skateboard: false },
  };
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    // Deep-merge mods so partial mod config doesn't wipe defaults.
    const merged = { ...defaults, ...parsed };
    merged.mods = { ...defaults.mods, ...(parsed.mods || {}) };
    return merged;
  } catch (err) {
    console.warn('[config] Could not read config.json, using defaults:', err.message);
    return defaults;
  }
}
const config = loadConfig();

// ---------- AutoMod (server-side profanity filter) ----------
// VoxelCraft is 8+ — ALL swearing, slurs, and bypasses are filtered.
const BAD_WORDS = new Set([
  'fuck','fucker','fucking','motherfucker','fuckin','fuk','fukkin',
  'shit','shitty','shite','bullshit','sh1t',
  'bitch','bitching','bitches','bich',
  'ass','asshole','arse','arsehole','dumbass','jackass',
  'dick','dickhead','dicks','cock','cocks','cocksucker',
  'pussy','pussies','cunt','twat','wanker','wank','bollocks','prick','bastard',
  'damn','goddamn','dammit','hell','crap','piss','pissed',
  'slut','sluts','slutty','whore','whores','douche','douchebag','dumbfuck','shitfuck',
  'porn','porno','pornography','hentai','sex','sexy','sexual','horny',
  'nude','naked','nudity','rape','raping','masturbate','masturbation',
  'boob','boobs','breast','breasts','penis','vagina','cum','ejaculate','milf','dildo',
  'nigger','nigga','nig','negro','faggot','fag','fagg','dyke','tranny','trannie',
  'retard','retarded','tard','spaz','spastic','midget','lame',
  'gook','chink','wetback','spic','kraut','kike',
  'cocaine','heroin','meth','crack','weed','marijuana','lsd','ecstasy',
  'nazi','nazis','hitler',
]);
const CHAR_SUBS = { '0':'o','1':'i','3':'e','4':'a','5':'s','7':'t','8':'b','@':'a','$':'s','!':'i','|':'i','+':'t','q':'k' };

function normalizeWord(input) {
  let s = input.toLowerCase();
  s = s.replace(/ph/g, 'f');
  let out = '';
  for (const ch of s) out += CHAR_SUBS[ch] || ch;
  out = out.replace(/v/g, 'u');
  out = out.replace(/[^a-z]/g, '');
  out = out.replace(/(.)\1+/g, '$1');
  return out;
}
function normalizeWordNoCollapse(input) {
  let s = input.toLowerCase();
  s = s.replace(/ph/g, 'f');
  let out = '';
  for (const ch of s) out += CHAR_SUBS[ch] || ch;
  out = out.replace(/v/g, 'u');
  out = out.replace(/[^a-z]/g, '');
  return out;
}
function isBad(normalized) {
  if (normalized.length < 2) return false;
  if (BAD_WORDS.has(normalized)) return true;
  if (normalized.length >= 3) {
    const vowels = 'aeiou';
    for (const bw of BAD_WORDS) {
      if (bw.length === normalized.length + 1) {
        for (let i = 0; i < bw.length; i++) {
          if (vowels.includes(bw[i]) && bw.slice(0, i) + bw.slice(i + 1) === normalized) return true;
        }
      }
    }
  }
  return false;
}
function filterProfanity(message) {
  if (!message) return message;
  return message.replace(/[a-z0-9@$.|!*~_\-+]+/gi, (chunk) => {
    if (isBad(normalizeWord(chunk)) || isBad(normalizeWordNoCollapse(chunk))) {
      return '#'.repeat(chunk.length);
    }
    return chunk;
  });
}

// ---------- Helpers ----------
function hashStringToSeed(str) {
  // DJB2 hash → deterministic numeric seed from a string.
  let h = 5381;
  for (let i = 0; i < String(str).length; i++) {
    h = ((h << 5) + h + String(str).charCodeAt(i)) | 0;
  }
  return h >>> 0; // force positive 32-bit
}

function genId() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

// Spawn-protection: never relay block-breaks (blockId 0) inside this radius (in blocks) of spawn (0,40,0).
const SPAWN_RADIUS = 16;
function isSpawnProtected(x, y, z) {
  if (!config.spawnProtection) return false;
  return Math.abs(x) <= SPAWN_RADIUS && Math.abs(z) <= SPAWN_RADIUS && y >= 32 && y <= 80;
}

// ---------- Player registry ----------
// Map<ws, playerObj>
const players = new Map();

// ---------- Ban registry ----------
// Map<deviceId, { username: string, until: number | null }>
// `until` is a Unix-ms timestamp; null means permanent.
// Persisted to bans.json so bans survive server restarts.
const BANS_PATH = path.join(__dirname, 'bans.json');
const bans = new Map();
function loadBans() {
  try {
    const raw = fs.readFileSync(BANS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      for (const [deviceId, entry] of Object.entries(parsed)) {
        if (entry && typeof entry === 'object') {
          bans.set(deviceId, {
            username: String(entry.username || ''),
            until: entry.until === null ? null : Number(entry.until) || 0,
          });
        }
      }
    }
    // Purge expired bans on load.
    const now = Date.now();
    let purged = 0;
    for (const [id, b] of bans.entries()) {
      if (b.until !== null && b.until < now) { bans.delete(id); purged++; }
    }
    if (purged > 0) saveBans();
    console.log(`[bans] Loaded ${bans.size} ban(s) from bans.json${purged ? ` (purged ${purged} expired)` : ''}.`);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn('[bans] Could not read bans.json:', err.message);
    }
  }
}
function saveBans() {
  try {
    const obj = {};
    for (const [id, b] of bans.entries()) {
      obj[id] = { username: b.username, until: b.until };
    }
    fs.writeFileSync(BANS_PATH, JSON.stringify(obj, null, 2));
  } catch (err) {
    console.warn('[bans] Could not write bans.json:', err.message);
  }
}
function isBanned(deviceId) {
  if (!deviceId) return null;
  const b = bans.get(deviceId);
  if (!b) return null;
  // Expired? Purge and treat as not banned.
  if (b.until !== null && b.until < Date.now()) {
    bans.delete(deviceId);
    saveBans();
    return null;
  }
  return b;
}
loadBans();

function broadcast(message, exceptWs = null) {
  const data = JSON.stringify(message);
  for (const client of players.keys()) {
    if (client === exceptWs) continue;
    if (client.readyState === 1 /* OPEN */) {
      try { client.send(data); } catch { /* ignore dead socket */ }
    }
  }
}

function snapshotPlayers() {
  const out = [];
  for (const p of players.values()) {
    out.push({
      id: p.id,
      username: p.username,
      mcUsername: p.mcUsername || '',
      x: p.x, y: p.y, z: p.z,
      yaw: p.yaw,
      heldItemId: p.heldItemId,
      armor: p.armor || [null, null, null, null],
      isOwner: false, // survival-only — no one is owner
    });
  }
  return out;
}

// ---------- HTTP server (for /status) ----------
const httpServer = http.createServer((req, res) => {
  // CORS — allow the game client (running on any origin) to probe server status.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.method === 'GET' && (req.url === '/status' || req.url === '/status/')) {
    // Include the list of currently-connected player usernames so clients can
    // do a pre-join name check (prevents duplicate names that would disrupt
    // banning).
    const playerList = [...players.values()].filter(p => p.username).map(p => p.username);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      online: true,
      playerCount: players.size,
      maxPlayers: config.maxPlayers,
      motd: config.motd,
      pvp: config.pvp,
      worldSeed: config.worldSeed,
      mods: config.mods,
      players: playerList,
    }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found. GET /status for server info.');
});

// ---------- WebSocket server ----------
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress || 'unknown';
  console.log(`[ws] new connection from ${ip}`);

  // Enforce max players BEFORE accepting a username. We allow the socket to
  // open, but reject the join if the server is full.
  if (players.size >= config.maxPlayers) {
    try {
      ws.send(JSON.stringify({ type: 'disconnect', reason: 'Server is full' }));
    } catch { /* ignore */ }
    ws.close(1013, 'Server is full');
    return;
  }

  // Initialize the player record (username is set on the first message).
  const player = {
    id: genId(),
    ws,
    ip,
    deviceId: '',
    username: 'Player',
    mcUsername: '',
    x: 8.5, y: 45, z: 8.5,
    yaw: 0,
    heldItemId: 0,
    armor: [null, null, null, null],
  };
  players.set(ws, player);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || typeof msg !== 'object' || !msg.type) return;
    const p = players.get(ws);
    if (!p) return;

    switch (msg.type) {
      case 'set_username': {
        const requestedName = String(msg.username || 'Player').slice(0, 32) || 'Player';

        // --- Ban check (by deviceId, NOT username) ---
        // deviceId is stable per browser (stored in localStorage). Banning by
        // deviceId means a banned player can't bypass by just changing their
        // username — they'd have to clear their browser storage.
        const deviceId = String(msg.deviceId || '').slice(0, 128);
        p.deviceId = deviceId;
        const ban = isBanned(deviceId);
        if (ban) {
          try {
            ws.send(JSON.stringify({
              type: 'banned',
              data: {
                msg: 'You are banned from this server',
                until: ban.until,
              },
            }));
          } catch { /* ignore */ }
          console.log(`[ban] Rejected ${requestedName} (device=${deviceId || '-'}) — banned${ban.until ? ' until ' + new Date(ban.until).toISOString() : ' permanently'}`);
          // Remove from player registry so we don't broadcast a leave event.
          players.delete(ws);
          try { ws.close(1008, 'Banned'); } catch {}
          return;
        }

        // --- Duplicate username check (case-insensitive) ---
        // Prevent two players from using the same name at the same time. We
        // compare against every OTHER currently-connected player (we're not
        // in the snapshot yet, so just check everyone).
        const lowerName = requestedName.toLowerCase();
        for (const other of players.values()) {
          if (other === p) continue;
          if (other.username && other.username.toLowerCase() === lowerName) {
            try {
              ws.send(JSON.stringify({
                type: 'duplicate_name',
                data: { msg: 'Sorry, someone already has that name in the server currently' },
              }));
            } catch { /* ignore */ }
            console.log(`[dup] Rejected ${requestedName} — name already in use`);
            players.delete(ws);
            try { ws.close(1008, 'Duplicate name'); } catch {}
            return;
          }
        }

        p.username = requestedName;
        p.mcUsername = String(msg.mcUsername || '').slice(0, 32);
        // Send the joining player the current snapshot.
        ws.send(JSON.stringify({
          type: 'joined',
          data: {
            id: p.id,
            players: snapshotPlayers(),
            // Send the server's configured mods (from config.json).
            serverMods: config.mods,
          },
        }));
        // Tell everyone else about the new player.
        broadcast({
          type: 'player_joined',
          data: {
            id: p.id,
            username: p.username,
            mcUsername: p.mcUsername,
            x: p.x, y: p.y, z: p.z,
            yaw: p.yaw,
            heldItemId: p.heldItemId,
            armor: p.armor,
            isOwner: false,
          },
        }, ws);
        console.log(`[join] ${p.username} (mc=${p.mcUsername || '-'}, device=${p.deviceId || '-'}, ip=${p.ip}) — ${players.size}/${config.maxPlayers}`);
        break;
      }

      case 'pos': {
        // Client sends frequent position updates (throttled client-side to ~20Hz).
        // We relay them so remote clients can interpolate.
        p.x = Number(msg.x) || p.x;
        p.y = Number(msg.y) || p.y;
        p.z = Number(msg.z) || p.z;
        p.yaw = Number(msg.yaw) || 0;
        p.heldItemId = Number(msg.heldItemId) || 0;
        if (Array.isArray(msg.armor)) p.armor = msg.armor.slice(0, 4);
        if (msg.mcUsername !== undefined) p.mcUsername = String(msg.mcUsername).slice(0, 32);
        broadcast({
          type: 'player_pos',
          data: {
            id: p.id,
            x: p.x, y: p.y, z: p.z,
            yaw: p.yaw,
            heldItemId: p.heldItemId,
            ...(msg.armor ? { armor: p.armor } : {}),
            ...(msg.mcUsername !== undefined ? { mcUsername: p.mcUsername } : {}),
          },
        }, ws);
        break;
      }

      case 'block': {
        const x = Math.floor(Number(msg.x));
        const y = Math.floor(Number(msg.y));
        const z = Math.floor(Number(msg.z));
        const blockId = Number(msg.blockId) | 0;
        // Spawn protection: refuse to relay block BREAKS (id 0) inside the spawn radius.
        if (blockId === 0 && isSpawnProtected(x, y, z)) {
          // Echo the existing block back to the breaker so their client rolls back.
          // (We don't know the existing block id — just send a no-op "still air" so the client re-fetches.
          //  In practice the client re-derives terrain from the seed, so this is a soft no-op.)
          return;
        }
        // Last-write-wins: just relay to everyone else.
        broadcast({
          type: 'block_update',
          data: { x, y, z, blockId },
        }, ws);
        break;
      }

      case 'chat': {
        let text = String(msg.msg || '').slice(0, 256);
        if (!text) break;
        // Server-side AutoMod: filter profanity (VoxelCraft is 8+).
        // This is a simple filter — the client also filters, but we double-check
        // here for defense in depth.
        text = filterProfanity(text);
        // allowCommands is survival-only / off by default; we still relay chat
        // (commands like /gamemode are ignored by the client unless allowCommands is true).
        broadcast({
          type: 'chat_msg',
          data: { username: p.username, msg: text },
        });
        console.log(`[chat] <${p.username}> ${text}`);
        break;
      }

      case 'gamemode': {
        // Survival-only: ignore gamemode change requests. (Server stays survival.)
        // Optionally broadcast a notice back to the requester.
        if (!config.allowCommands) {
          try { ws.send(JSON.stringify({ type: 'chat_msg', data: { username: 'Server', msg: 'Gamemode changes are disabled (survival-only).' } })); } catch {}
          return;
        }
        // If allowed, relay to everyone.
        broadcast({ type: 'gamemode_change', data: { gamemode: msg.gamemode } });
        break;
      }

      case 'player_hit': {
        // PvP: relay hit to the target player.
        const target = [...players.values()].find(pp => pp.id === msg.targetId);
        if (!target || target === p) break;
        const damage = Number(msg.damage) || 4;
        try { target.ws.send(JSON.stringify({ type: 'player_hit', data: { sourceId: p.id, targetId: target.id, damage, sourceUsername: p.username } })); } catch {}
        break;
      }

      case 'mods': {
        // Update + relay server-side mod state. Any player can toggle (no owner).
        // Only server-side mods (sharks, skateboard) are accepted; client-side
        // mods (fullbright, shaders) are per-player and never sent to the server.
        const incoming = msg.mods && typeof msg.mods === 'object' ? msg.mods : {};
        if (typeof incoming.sharks === 'boolean') config.mods.sharks = incoming.sharks;
        if (typeof incoming.skateboard === 'boolean') config.mods.skateboard = incoming.skateboard;
        broadcast({ type: 'mod_sync', data: config.mods });
        console.log(`[mods] Updated: sharks=${config.mods.sharks} skateboard=${config.mods.skateboard}`);
        break;
      }

      default:
        // Unknown message — ignore silently.
        break;
    }
  });

  ws.on('close', () => {
    const p = players.get(ws);
    players.delete(ws);
    if (p) {
      console.log(`[leave] ${p.username} — ${players.size}/${config.maxPlayers}`);
      broadcast({ type: 'player_left', data: { id: p.id } });
    }
  });

  ws.on('error', (err) => {
    console.warn('[ws] socket error:', err.message);
  });
});

// ---------- Start ----------
// Port: config.json port, OR the PORT env var (set by Render/Heroku), OR 3001.
// If config.port is 0, use the env var (cloud hosting).
const PORT = Number(config.port) > 0 ? Number(config.port) : (process.env.PORT ? Number(process.env.PORT) : 3001);
httpServer.listen(PORT, () => {
  console.log('============================================');
  console.log('  VoxelCraft Multiplayer Server');
  console.log('============================================');
  console.log(`  Port:           ${PORT}`);
  console.log(`  Max players:    ${config.maxPlayers}`);
  console.log(`  MOTD:           ${config.motd}`);
  console.log(`  World seed:     ${config.worldSeed} (numeric: ${hashStringToSeed(config.worldSeed)})`);
  console.log(`  PVP:            ${config.pvp ? 'ON' : 'OFF'}`);
  console.log(`  Spawn protect:  ${config.spawnProtection ? 'ON (radius ' + SPAWN_RADIUS + ')' : 'OFF'}`);
  console.log(`  Commands:       ${config.allowCommands ? 'ALLOWED' : 'DISABLED (survival-only)'}`);
  console.log(`  Mods:           sharks=${config.mods.sharks ? 'ON' : 'off'}  skateboard=${config.mods.skateboard ? 'ON' : 'off'}`);
  console.log('--------------------------------------------');
  console.log(`  WebSocket:      ws://localhost:${PORT}`);
  console.log(`  Status:         http://localhost:${PORT}/status`);
  console.log('============================================');
  console.log('');
  console.log('Share your public IP + this port with friends.');
  console.log('If behind a router, port-forward this port (TCP).');
  console.log('');
  console.log('Console commands:');
  console.log('  /list               — list all connected players');
  console.log('  /ban <user> [days]  — ban a player by deviceId (0 days = permanent)');
  console.log('  /unban <user>       — remove a ban for that username');
  console.log('  /bans               — list all active bans');
  console.log('');
});

// ---------- Console command interface ----------
// Reads stdin line by line. Supports:
//   /list               — list connected players (username, deviceId, IP)
//   /ban <user> [days]  — ban a connected player's deviceId for N days (0 = permanent), kick them
//   /unban <user>       — remove the ban entry for that username
//   /bans               — list all active bans
//   /help               — show this help
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });

function findPlayerByName(name) {
  const lower = String(name || '').toLowerCase();
  for (const p of players.values()) {
    if (p.username && p.username.toLowerCase() === lower) return p;
  }
  return null;
}

function formatUntil(until) {
  if (until === null || until === undefined) return 'permanent';
  const ms = until - Date.now();
  if (ms <= 0) return 'expired';
  const days = Math.floor(ms / 86400000);
  const hours = Math.floor((ms % 86400000) / 3600000);
  if (days > 0) return `${days}d ${hours}h remaining`;
  const mins = Math.floor((ms % 3600000) / 60000);
  return `${hours}h ${mins}m remaining`;
}

rl.on('line', (line) => {
  const input = String(line || '').trim();
  if (!input) return;
  if (!input.startsWith('/')) {
    console.log('Unknown command. Type /help for a list of commands.');
    return;
  }
  const parts = input.slice(1).split(/\s+/);
  const cmd = (parts[0] || '').toLowerCase();
  const args = parts.slice(1);

  switch (cmd) {
    case 'help': {
      console.log('Commands:');
      console.log('  /list               — list all connected players');
      console.log('  /ban <user> [days]  — ban a player by deviceId (0 days = permanent)');
      console.log('  /unban <user>       — remove a ban for that username');
      console.log('  /bans               — list all active bans');
      break;
    }

    case 'list': {
      if (players.size === 0) {
        console.log('No players connected.');
        break;
      }
      console.log(`--- Connected players (${players.size}/${config.maxPlayers}) ---`);
      let i = 1;
      for (const p of players.values()) {
        console.log(`  ${i++}. ${p.username}` +
          (p.mcUsername ? ` (mc=${p.mcUsername})` : '') +
          `  device=${p.deviceId || '-'}` +
          `  ip=${p.ip}` +
          `  pos=(${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)})`);
      }
      break;
    }

    case 'ban': {
      const targetName = args[0];
      if (!targetName) {
        console.log('Usage: /ban <username> [days]  (0 days = permanent)');
        break;
      }
      const days = args[1] !== undefined ? Math.max(0, Number(args[1]) || 0) : 0;
      const until = days > 0 ? Date.now() + days * 86400000 : null;
      const target = findPlayerByName(targetName);
      if (!target) {
        console.log(`Player "${targetName}" is not currently connected. (You can only ban online players.)`);
        break;
      }
      if (!target.deviceId) {
        console.log(`Player "${target.username}" has no deviceId — cannot ban.`);
        break;
      }
      bans.set(target.deviceId, { username: target.username, until });
      saveBans();
      // Kick the player.
      try {
        target.ws.send(JSON.stringify({
          type: 'banned',
          data: {
            msg: 'You are banned from this server',
            until,
          },
        }));
      } catch { /* ignore */ }
      try { target.ws.close(1008, 'Banned'); } catch {}
      console.log(`[ban] Banned ${target.username} (device=${target.deviceId}, ip=${target.ip})` +
        (until ? ` until ${new Date(until).toISOString()}` : ' permanently') +
        ` — kicked.`);
      break;
    }

    case 'unban': {
      const targetName = args[0];
      if (!targetName) {
        console.log('Usage: /unban <username>');
        break;
      }
      const lower = targetName.toLowerCase();
      let removed = 0;
      for (const [id, b] of bans.entries()) {
        if (b.username && b.username.toLowerCase() === lower) {
          bans.delete(id);
          removed++;
        }
      }
      if (removed > 0) {
        saveBans();
        console.log(`[unban] Removed ${removed} ban(s) for "${targetName}".`);
      } else {
        console.log(`No ban found for "${targetName}". (Use /bans to list active bans.)`);
      }
      break;
    }

    case 'bans': {
      if (bans.size === 0) {
        console.log('No active bans.');
        break;
      }
      console.log(`--- Active bans (${bans.size}) ---`);
      let i = 1;
      for (const [id, b] of bans.entries()) {
        console.log(`  ${i++}. ${b.username}  device=${id}  expires=${formatUntil(b.until)}`);
      }
      break;
    }

    default:
      console.log(`Unknown command: /${cmd}. Type /help for a list of commands.`);
      break;
  }
  rl.prompt();
});

process.stdin.on('end', () => { /* stdin closed — keep running (e.g. when run as a service) */ });

// Graceful shutdown.
function shutdown(signal) {
  console.log(`\n[${signal}] shutting down...`);
  for (const client of players.keys()) {
    try { client.send(JSON.stringify({ type: 'disconnect', reason: 'Server shutting down' })); } catch {}
    try { client.close(1001, 'Server shutting down'); } catch {}
  }
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
