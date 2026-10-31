// HTTP + WebSocket server. It holds the authoritative game state for each room:
// clients only ask for moves, and every move is checked with the shared engine.
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { createGame, applyMove, resign, COLORS } from '../shared/engine.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 3000;
const DATA_FILE = process.env.DATA_FILE || path.join(ROOT, 'data', 'games.json');
const ROOM_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_ROOMS = 1000;

// Only these files are ever served, so there is no path handling to get wrong.
const STATIC_FILES = {
  '/': ['client/index.html', 'text/html; charset=utf-8'],
  '/client.js': ['client/client.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['client/style.css', 'text/css; charset=utf-8'],
  '/engine.js': ['shared/engine.js', 'text/javascript; charset=utf-8'],
};

// code -> { code, game, seats: { w: { name, token } | null, ... }, updatedAt }
const rooms = new Map();
// code -> Map(socket -> color | null)
const sockets = new Map();

function loadRooms() {
  try {
    for (const room of JSON.parse(readFileSync(DATA_FILE, 'utf8'))) {
      // Games saved before moats existed keep playing with all three.
      if (room.game) room.game.moats ??= createGame().moats;
      rooms.set(room.code, room);
    }
    console.log(`Restored ${rooms.size} game(s) from ${DATA_FILE}`);
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('Could not read saved games:', err.message);
  }
}

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try {
      await mkdir(path.dirname(DATA_FILE), { recursive: true });
      const temp = `${DATA_FILE}.tmp`;
      await writeFile(temp, JSON.stringify([...rooms.values()]));
      await rename(temp, DATA_FILE);
    } catch (err) {
      console.error('Could not save games:', err.message);
    }
  }, 500);
}

function touch(room) {
  room.updatedAt = Date.now();
  scheduleSave();
}

function pruneRooms() {
  const cutoff = Date.now() - ROOM_TTL_MS;
  for (const [code, room] of rooms) {
    if (room.updatedAt < cutoff && !sockets.get(code)?.size) rooms.delete(code);
  }
}

function newRoom() {
  pruneRooms();
  if (rooms.size >= MAX_ROOMS) throw new Error('Server is full, try again later');
  // No easily confused characters, since people may read these out to friends.
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = [...randomBytes(6)].map((b) => alphabet[b % alphabet.length]).join('');
  } while (rooms.has(code));
  const room = { code, game: null, seats: { w: null, g: null, b: null }, updatedAt: Date.now() };
  rooms.set(code, room);
  scheduleSave();
  return room;
}

function send(socket, message) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function broadcast(room) {
  const connected = sockets.get(room.code) ?? new Map();
  const online = new Set(connected.values());
  const players = Object.fromEntries(COLORS.map((color) => [color, room.seats[color]
    ? { name: room.seats[color].name, online: online.has(color) }
    : null]));
  for (const [socket, color] of connected) {
    send(socket, { type: 'room', code: room.code, you: color, players, game: room.game });
  }
}

function attach(socket, room, color) {
  if (socket.room && socket.room !== room) detach(socket);
  socket.room = room;
  if (!sockets.has(room.code)) sockets.set(room.code, new Map());
  sockets.get(room.code).set(socket, color);
}

function detach(socket) {
  if (!socket.room) return;
  const { code } = socket.room;
  const connected = sockets.get(code);
  connected?.delete(socket);
  if (connected?.size === 0) sockets.delete(code);
  const room = socket.room;
  socket.room = null;
  if (rooms.has(code)) broadcast(room);
}

const handlers = {
  create(socket) {
    const room = newRoom();
    attach(socket, room, null);
    broadcast(room);
  },

  // Open a room, retaking a seat if the token matches one.
  join(socket, { code, token }) {
    const room = rooms.get(String(code ?? '').toUpperCase());
    if (!room) throw new Error('That game does not exist');
    const color = COLORS.find((c) => token && room.seats[c]?.token === token) ?? null;
    attach(socket, room, color);
    broadcast(room);
  },

  sit(socket, { color, name }) {
    const room = socket.room;
    if (!room) throw new Error('Join a game first');
    if (room.game) throw new Error('The game has already started');
    if (!COLORS.includes(color)) throw new Error('Unknown colour');
    if (room.seats[color]) throw new Error('That seat is taken');
    if (sockets.get(room.code).get(socket)) throw new Error('You already have a seat');
    const cleanName = String(name ?? '').trim().slice(0, 24) || 'Player';
    const token = randomBytes(24).toString('hex');
    room.seats[color] = { name: cleanName, token };
    sockets.get(room.code).set(socket, color);
    send(socket, { type: 'seat', code: room.code, token });
    if (COLORS.every((c) => room.seats[c])) room.game = createGame();
    touch(room);
    broadcast(room);
  },

  move(socket, { from, to, promotion }) {
    const room = socket.room;
    const color = room && sockets.get(room.code).get(socket);
    if (!room?.game || !color) throw new Error('You are not playing in this game');
    if (room.game.turn !== color) throw new Error('It is not your turn');
    room.game = applyMove(room.game, { from, to, promotion });
    touch(room);
    broadcast(room);
  },

  resign(socket) {
    const room = socket.room;
    const color = room && sockets.get(room.code).get(socket);
    if (!room?.game || !color) throw new Error('You are not playing in this game');
    room.game = resign(room.game, color);
    touch(room);
    broadcast(room);
  },
};

async function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/health') {
    res.writeHead(200).end('ok');
    return;
  }
  const entry = STATIC_FILES[url.pathname];
  if (!entry || req.method !== 'GET') {
    res.writeHead(404).end('Not found');
    return;
  }
  try {
    const body = await readFile(path.join(ROOT, entry[0]));
    res.writeHead(200, { 'Content-Type': entry[1], 'Cache-Control': 'no-cache' }).end(body);
  } catch {
    res.writeHead(500).end('Server error');
  }
}

loadRooms();
const server = createServer(serveStatic);
const wss = new WebSocketServer({ server, maxPayload: 4096 });

wss.on('connection', (socket) => {
  socket.isAlive = true;
  socket.on('pong', () => { socket.isAlive = true; });
  socket.on('error', () => {});
  socket.on('close', () => detach(socket));
  socket.on('message', (data) => {
    try {
      const message = JSON.parse(data);
      if (!Object.hasOwn(handlers, message?.type)) throw new Error('Unknown request');
      handlers[message.type](socket, message);
    } catch (err) {
      send(socket, { type: 'error', message: err.message });
    }
  });
});

// Drops dead connections, and keeps idle ones open through hosting proxies.
setInterval(() => {
  for (const socket of wss.clients) {
    if (!socket.isAlive) {
      socket.terminate();
      continue;
    }
    socket.isAlive = false;
    socket.ping();
  }
}, 30000).unref();

server.listen(PORT, () => {
  console.log(`Three-player chess running at http://localhost:${PORT}`);
});
