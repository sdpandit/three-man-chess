// HTTP + WebSocket server. It holds the authoritative game state for each room:
// clients only ask for moves, and every move is checked with the shared engine.
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { createGame, applyMove, resign, COLORS } from '../shared/engine.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 3000;
const DATA_FILE = process.env.DATA_FILE || path.join(ROOT, 'data', 'games.json');
const ROOM_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_ROOMS = 1000;
const MAX_CHAT_MESSAGES = 200;
const MAX_CHAT_LENGTH = 300;
const CHAT_COOLDOWN_MS = 250;
const ADMIN_TOKEN_FILE = path.join(path.dirname(DATA_FILE), 'admin-token');

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
      room.chat ??= [];
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
  const room = { code, game: null, seats: { w: null, g: null, b: null }, chat: [], updatedAt: Date.now() };
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

// Names are shown as text, never as HTML, so only their length needs limiting.
// What players see of a chat message: nothing marks one posted under a made-up name.
const publicChat = ({ color, name, text }) => ({ color, name, text });

const cleanName = (name) => String(name ?? '').trim().slice(0, 24) || 'Player';

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
    send(socket, { type: 'chatHistory', messages: room.chat.map(publicChat) });
    broadcast(room);
  },

  sit(socket, { color, name }) {
    const room = socket.room;
    if (!room) throw new Error('Join a game first');
    if (room.game) throw new Error('The game has already started');
    if (!COLORS.includes(color)) throw new Error('Unknown colour');
    if (room.seats[color]) throw new Error('That seat is taken');
    if (sockets.get(room.code).get(socket)) throw new Error('You already have a seat');
    const token = randomBytes(24).toString('hex');
    room.seats[color] = { name: cleanName(name), token };
    sockets.get(room.code).set(socket, color);
    send(socket, { type: 'seat', code: room.code, token });
    if (COLORS.every((c) => room.seats[c])) room.game = createGame();
    touch(room);
    broadcast(room);
  },

  // Players can change their name at any time, even mid-game. Their past chat messages
  // take the new name too, but messages posted under a made-up name keep theirs.
  rename(socket, { name }) {
    const room = socket.room;
    const color = room && sockets.get(room.code).get(socket);
    if (!color) throw new Error('Take a seat first');
    const newName = cleanName(name);
    room.seats[color].name = newName;
    let chatChanged = false;
    for (const message of room.chat) {
      if (message.color !== color || message.custom || message.name === newName) continue;
      message.name = newName;
      chatChanged = true;
    }
    touch(room);
    broadcast(room);
    if (chatChanged) {
      for (const client of sockets.get(room.code).keys()) send(client, { type: 'chatHistory', messages: room.chat.map(publicChat) });
    }
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

  // Anyone with the link can read the chat, but only seated players can write in it.
  chat(socket, { text }) {
    const room = socket.room;
    const color = room && sockets.get(room.code).get(socket);
    if (!room?.game || !color) throw new Error('Only players can chat');
    const clean = String(text ?? '').trim().slice(0, MAX_CHAT_LENGTH);
    if (!clean) return;
    const now = Date.now();
    if (now - (socket.lastChatAt ?? 0) < CHAT_COOLDOWN_MS) throw new Error('Slow down a little');
    socket.lastChatAt = now;
    const message = { color, name: room.seats[color].name, text: clean };
    room.chat.push(message);
    room.chat.splice(0, room.chat.length - MAX_CHAT_MESSAGES);
    touch(room);
    for (const client of sockets.get(room.code).keys()) send(client, { type: 'chat', message });
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

// The admin token sits next to the saved games and stays the same across restarts.
// Requests through a tunnel arrive from localhost too, so the token is the only guard.
function loadAdminToken() {
  try {
    return readFileSync(ADMIN_TOKEN_FILE, 'utf8').trim();
  } catch {
    const token = randomBytes(24).toString('hex');
    mkdirSync(path.dirname(ADMIN_TOKEN_FILE), { recursive: true });
    writeFileSync(ADMIN_TOKEN_FILE, token, { mode: 0o600 });
    return token;
  }
}
const adminToken = Buffer.from(loadAdminToken());

function isAdmin(req) {
  const given = Buffer.from(String(req.headers.authorization ?? '').replace(/^Bearer /, ''));
  return given.length === adminToken.length && timingSafeEqual(given, adminToken);
}

// POST /admin/chat with { room, name, text, color? } posts a chat message under any name.
// `npm run say` wraps it.
async function adminChat(req, res) {
  const reply = (status, body) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
  if (!isAdmin(req)) return reply(403, { error: 'Bad admin token' });
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 4096) return reply(413, { error: 'Too long' });
  }
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return reply(400, { error: 'Body must be JSON' });
  }
  const room = rooms.get(String(body.room ?? '').toUpperCase());
  if (!room) return reply(404, { error: 'That game does not exist' });
  const text = String(body.text ?? '').trim().slice(0, MAX_CHAT_LENGTH);
  if (!text) return reply(400, { error: 'Empty message' });
  const color = COLORS.includes(body.color) ? body.color : null;
  const message = { color, name: cleanName(body.name), text, custom: true };
  room.chat.push(message);
  room.chat.splice(0, room.chat.length - MAX_CHAT_MESSAGES);
  touch(room);
  for (const client of sockets.get(room.code)?.keys() ?? []) send(client, { type: 'chat', message: publicChat(message) });
  return reply(200, { sent: message, watching: sockets.get(room.code)?.size ?? 0 });
}

async function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/health') {
    res.writeHead(200).end('ok');
    return;
  }
  if (url.pathname === '/admin/chat' && req.method === 'POST') {
    await adminChat(req, res);
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
