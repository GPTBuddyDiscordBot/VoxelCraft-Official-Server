# VoxelCraft Server Template

Host your own VoxelCraft multiplayer server! This is a tiny Node.js WebSocket server
that relays player positions, block changes, and chat between connected clients.

> **Survival-only.** There is NO owner concept — all players are equal. Anyone can
> mine, build, chat, and toggle server-side mods. There are no admin commands.

---

## Quick Start

### 1. Install Node.js
Download and install **Node.js 18 or newer** from <https://nodejs.org/>.

Verify it works:
```bash
node --version    # should print v18.x.x or higher
npm --version
```

### 2. Install dependencies
From inside this folder (where `package.json` lives):
```bash
npm install
```
This installs the `ws` WebSocket library — the only dependency.

### 3. Configure your server
Open `config.json` in a text editor and tweak the settings:

```json
{
  "port": 3001,                  // TCP port the server listens on
  "maxPlayers": 20,              // maximum concurrent players
  "motd": "My VoxelCraft Server", // shown in the server browser
  "worldSeed": "my-server",      // string — hashed to a numeric seed that EVERY client uses to generate identical terrain
  "pvp": true,                   // allow player-vs-player combat (informational — clients decide)
  "spawnProtection": true,       // prevent block-breaking near spawn (radius 16 blocks)
  "allowCommands": false,        // survival-only: leave false to disable /gamemode etc.
  "mods": {                      // server-side mods — applied to ALL players on join
    "sharks": false,             // spawn sharks in oceans (affects gameplay)
    "skateboard": false          // rideable skateboard (affects gameplay)
  }
```

> **Tip:** Change `worldSeed` to anything you like. All players on your server will
> generate the exact same world terrain from this seed, so nobody floats or falls
> through mismatched ground.

> **Server-side mods:** Set `sharks` or `skateboard` to `true` in config.json to
> enable them for ALL players on your server. When a player joins, the server
> sends its mod config and the client auto-enables/disables the mods to match.
> Any player can also toggle server-side mods in-game via the Mods menu — the
> change is broadcast to everyone. Client-side mods (Fullbright, Shaders) are
> per-player and never sent to the server.

### 4. Start the server
```bash
npm start
```
You should see a banner like:
```
============================================
  VoxelCraft Multiplayer Server
============================================
  Port:           3001
  Max players:    20
  MOTD:           My VoxelCraft Server
  World seed:     my-server (numeric: 1234567890)
  ...
```

### 5. Make your server reachable

You have two options: **host at home** (free, low latency, PC must stay on) or
**host on Render** (free cloud, 24/7, no port forwarding).

---

## Option A: Host at Home (Local)

Best for: friends on your WiFi, lowest latency, full control. Your PC must stay
on while playing.

### A.1 Port forward your router
1. Find your public IP — visit <https://whatismyip.com>.
2. Log into your router's admin page (usually `http://192.168.1.1`).
3. Find "Port Forwarding" / "Virtual Server".
4. Forward TCP port `3001` to your computer's local IP (e.g. `192.168.1.50`).
5. Make sure your computer's firewall allows inbound TCP on port `3001`
   (Windows Defender Firewall → Allow an app, or `sudo ufw allow 3001/tcp` on Linux).

### A.2 Find your local IP (for LAN play)
- **Windows:** `ipconfig` → look for "IPv4 Address" under your WiFi/Ethernet adapter.
- **Mac/Linux:** `ifconfig` or `ip addr` → look for `inet 192.168.x.x`.

### A.3 Share your address
- **Same WiFi (LAN):** `ws://192.168.1.50:3001` (your local IP)
- **Over the internet:** `ws://203.0.113.10:3001` (your public IP, requires port forwarding)

---

## Option B: Host on Render (Free Cloud via GitHub)

Best for: 24/7 public servers, no port forwarding needed, shareable URL.
Render's free tier spins down after 15 min of inactivity — the first connection
takes ~30 seconds to wake the server.

### B.1 Create a GitHub repository
1. Go to <https://github.com> → **New repository**.
2. Name it (e.g. `my-voxelcraft-server`), set it to **Public**.
3. Click **Create repository**.

### B.2 Upload the server files
Upload all 4 files from this template (`server.js`, `package.json`, `config.json`,
`README.md`) to your repo. You can drag-and-drop them on the GitHub web page, or use git:
```bash
git init
git add .
git commit -m "Initial VoxelCraft server"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/my-voxelcraft-server.git
git push -u origin main
```

### B.3 Edit config.json for Render
Set `"port": 0` in `config.json` — Render assigns the port via the `PORT`
environment variable, which the server auto-detects:
```json
{
  "port": 0,
  "maxPlayers": 20,
  "motd": "My Cloud VoxelCraft Server",
  ...
}
```
Commit the change to GitHub.

### B.4 Create a Render Web Service
1. Go to <https://render.com> and sign up (free).
2. Click **New +** → **Web Service**.
3. Connect your GitHub account and select your `my-voxelcraft-server` repo.
4. Configure:
   - **Name:** `my-voxelcraft-server` (or anything)
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
   - **Instance Type:** Free
5. Click **Create Web Service**.

### B.5 Wait for deployment
Render will build and deploy your server. Once live, it gives you a URL like:
```
https://my-voxelcraft-server.onrender.com
```
Test it — visit `https://my-voxelcraft-server.onrender.com/status` in your browser.
You should see the JSON status.

### B.6 Share your address
Give friends: `wss://my-voxelcraft-server.onrender.com`
(The `wss://` prefix means secure WebSocket — required for HTTPS hosting.)

### B.7 Edit config later
Push changes to `config.json` on GitHub → Render auto-redeploys. Change
`maxPlayers`, `motd`, `worldSeed`, etc. anytime.

---

## Option C: Other Cloud Platforms

The server is a standard Node.js app — it works on Railway, Fly.io, Heroku,
DigitalOcean App Platform, or any VPS. Just make sure:
- The start command is `node server.js`
- The port is set via the `PORT` env var (set `config.port` to `0`)
- WebSocket connections are allowed (most platforms allow this by default)


---

## How it works

- **Player join / leave** — The server tracks each connection and tells everyone else
  when a player joins (`player_joined`) or leaves (`player_left`). Usernames and
  Minecraft usernames (used for skin loading) are relayed.
- **Positions** — Clients send their position ~20×/sec. The server re-broadcasts them
  so remote clients can smoothly **interpolate** other players between snapshots.
- **Blocks** — When a player breaks or places a block, the change is relayed to all
  other clients. **Last-write-wins** — the most recent edit for a given coordinate
  is the one everyone sees. Terrain itself is generated locally from `worldSeed`,
  so the server doesn't store block data.
- **Chat** — Plain text chat is relayed to everyone.
- **Spawn protection** — When `spawnProtection: true`, block-breaks (id 0) within
  16 blocks of spawn (0, 40, 0) are silently dropped.
- **Status endpoint** — `GET http://your-server:3001/status` returns:
  ```json
  { "online": true, "playerCount": 3, "maxPlayers": 20, "motd": "My VoxelCraft Server", "pvp": true, "worldSeed": "my-server" }
  ```
  The server browser uses this to show online/offline status and player counts.

---

## Troubleshooting

**Friends can't connect?**
- Make sure the server is running (`npm start` shows the banner).
- Make sure port `3001` is forwarded in your router AND allowed through your OS firewall.
- Double-check you gave them the right IP and port — try `http://YOUR_IP:3001/status`
  in a browser; you should see the JSON status.

**Players see different terrain?**
- Everyone must be using the **exact same** `worldSeed` (the server's value is what
  counts — clients derive their seed from the server URL so it always matches).

**Want to change settings without editing files?**
- Edit `config.json`, save, then restart the server (`Ctrl+C` then `npm start`).

---

Enjoy your own private VoxelCraft world! 🌍⛏️
