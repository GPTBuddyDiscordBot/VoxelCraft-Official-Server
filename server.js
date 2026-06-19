const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;

// ===== Game State =====
const players = new Map();
let ownerSet = false;
let serverMods = { sharks: false, skateboard: false };
const SERVER_SIDE_MODS = ['sharks', 'skateboard'];

// ===== HTTP Server (status + keep-alive) =====
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      online: true,
      players: Array.from(players.values()).map(p => ({
        username: p.username,
        isOwner: p.isOwner,
      })),
      playerCount: players.size,
      maxPlayers: 20,
      motd: 'VoxelCraft Official Server',
      version: '1.0.0',
    }));
    return;
  }

  if (req.url === '/ping') {
    res.writeHead(200);
    res.end('pong');
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('VoxelCraft Multiplayer Server');
});

// ===== WebSocket Server =====
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  const playerId = 'p' + Date.now() + Math.floor(Math.random() * 1000);
  const isOwner = !ownerSet;
  if (isOwner) ownerSet = true;

  const player = {
    id: playerId,
    username: 'Player',
    x: 8.5, y: 40, z: 8.5,
    yaw: 0, pitch: 0,
    heldItemId: 0,
    isOwner,
    gamemode: 'survival',
    lastSeen: Date.now(),
  };
  players.set(playerId, player);

  // Send join confirmation
  ws.send(JSON.stringify({
    type: 'joined',
    data: {
      id: playerId,
      isOwner,
      players: Array.from(players.values()).filter(p => p.id !== playerId),
      serverMods: { ...serverMods },
    }
  }));

  // Notify others
  broadcast(ws, {
    type: 'player_joined',
    data: { id: playerId, username: player.username, isOwner, x: player.x, y: player.y, z: player.z, yaw: 0 }
  });

  console.log(player.username + ' joined (' + players.size + ' players)');

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const p = players.get(playerId);
    if (!p) return;
    p.lastSeen = Date.now();

    switch (msg.type) {
      case 'set_username':
        p.username = msg.username || 'Player';
        broadcast(ws, { type: 'player_update', data: { id: playerId, username: p.username } });
        break;

      case 'pos':
        p.x = msg.x; p.y = msg.y; p.z = msg.z;
        p.yaw = msg.yaw; p.pitch = msg.pitch;
        p.heldItemId = msg.heldItemId;
        broadcast(ws, { type: 'player_pos', data: { id: playerId, x: msg.x, y: msg.y, z: msg.z, yaw: msg.yaw, pitch: msg.pitch, heldItemId: msg.heldItemId } });
        break;

      case 'block':
        broadcast(ws, { type: 'block_update', data: { x: msg.x, y: msg.y, z: msg.z, blockId: msg.blockId } });
        break;

      case 'chat':
        broadcast(ws, { type: 'chat_msg', data: { username: p.username, msg: msg.msg } });
        break;

      case 'gamemode':
        if (!p.isOwner) {
          ws.send(JSON.stringify({ type: 'error', data: 'Only the owner can change gamemode' }));
          return;
        }
        p.gamemode = msg.gamemode;
        broadcastAll({ type: 'gamemode_change', data: { gamemode: msg.gamemode } });
        break;

      case 'mods':
        if (!p.isOwner) return;
        for (const m of SERVER_SIDE_MODS) {
          if (msg.mods[m] !== undefined) serverMods[m] = msg.mods[m];
        }
        broadcastAll({ type: 'mod_sync', data: { ...serverMods } });
        break;
    }
  });

  ws.on('close', () => {
    const p = players.get(playerId);
    if (p) {
      console.log(p.username + ' left');
      players.delete(playerId);
      broadcastAll({ type: 'player_left', data: { id: playerId } });

      if (p.isOwner && players.size > 0) {
        const newOwner = players.values().next().value;
        newOwner.isOwner = true;
        broadcastAll({ type: 'owner_change', data: { id: newOwner.id } });
      } else if (players.size === 0) {
        ownerSet = false;
      }
    }
  });
});

// ===== Helpers =====
function broadcast(sender, msg) {
  const data = JSON.stringify(msg);
  wss.clients.forEach((client) => {
    if (client !== sender && client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  });
}

function broadcastAll(msg) {
  const data = JSON.stringify(msg);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  });
}

// ===== Keep-Alive (prevents Render sleep) =====
setInterval(() => {
  http.get('http://localhost:' + PORT + '/ping', (res) => {
    console.log('Keep-alive ping: ' + res.statusCode);
  }).on('error', () => {});
}, 10 * 60 * 1000);

// ===== Prune inactive players (30s timeout) =====
setInterval(() => {
  const now = Date.now();
  for (const [id, p] of players) {
    if (now - p.lastSeen > 30000) {
      players.delete(id);
      broadcastAll({ type: 'player_left', data: { id } });
      console.log(p.username + ' timed out');
    }
  }
}, 15000);

server.listen(PORT, () => {
  console.log('VoxelCraft server running on port ' + PORT);
});