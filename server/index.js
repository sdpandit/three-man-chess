// HTTP + WebSocket server. It holds the authoritative game state for each room:
// clients only ask for moves, and every move is checked with the shared engine.
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { createGame, applyMove, resign, timeOut, COLORS } from '../shared/engine.js';
import {
  parseTimeControl, createClock, runningColor, timeLeft, settle, hasFlagged, pause, resume,
} from './clock.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 3000;
const DATA_FILE = process.env.DATA_FILE || path.join(ROOT, 'data', 'games.json');
const ROOM_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_ROOMS = 1000;
const MAX_CHAT_MESSAGES = 200;
const MAX_CHAT_LENGTH = 300;
const CHAT_COOLDOWN_MS = 250;
// A takeback request is declined if not everyone has answered within this long.
const TAKEBACK_TIMEOUT_MS = Number(process.env.TAKEBACK_TIMEOUT_MS) || 15000;
const ADMIN_TOKEN_FILE = path.join(path.dirname(DATA_FILE), 'admin-token');

// Only these files are ever served, so there is no path handling to get wrong.
const STATIC_FILES = {
  '/': ['client/index.html', 'text/html; charset=utf-8'],
  '/client.js': ['client/client.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['client/style.css', 'text/css; charset=utf-8'],
  '/engine.js': ['shared/engine.js', 'text/javascript; charset=utf-8'],
};

// code -> { code, game, seats: { w: { name, token } | null, ... }, chat, timeControl, clock,
//           undo, takeback, hostToken, updatedAt }
// timeControl is { minutes, increment } or null, and clock is set once the game starts.
// hostToken belongs to whoever created the room, who can change the time control until then.
// undo is what the latest move can be taken back to, and takeback a pending request for it.
const rooms = new Map();
// code -> Map(socket -> color | null)
const sockets = new Map();
// code -> the timer that ends the turn of the player on move when their clock runs out
const flagTimers = new Map();
// code -> the timer that declines a takeback request nobody finished answering
const takebackTimers = new Map();

function loadRooms() {
  try {
    for (const room of JSON.parse(readFileSync(DATA_FILE, 'utf8'))) {
      // Games saved before moats existed keep playing with all three.
      if (room.game) room.game.moats ??= createGame().moats;
      room.chat ??= [];
      room.timeControl ??= null;
      // Clocks stop while the server is down, rather than charging whoever was on move.
      if (room.clock) room.clock.since = Date.now();
      rooms.set(room.code, room);
      scheduleFlag(room);
      // A pending request keeps the time it had left when last saved, as the clocks do.
      if (room.takeback) {
        const left = (room.takeback.expiresAt ?? 0) - room.updatedAt;
        scheduleTakebackExpiry(room, Math.min(Math.max(left, 0), TAKEBACK_TIMEOUT_MS));
      }
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
    if (room.updatedAt < cutoff && !sockets.get(code)?.size) {
      rooms.delete(code);
      clearTimeout(flagTimers.get(code));
      flagTimers.delete(code);
      clearTimeout(takebackTimers.get(code));
      takebackTimers.delete(code);
    }
  }
}

function newRoom(timeControl) {
  pruneRooms();
  if (rooms.size >= MAX_ROOMS) throw new Error('Server is full, try again later');
  // No easily confused characters, since people may read these out to friends.
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = [...randomBytes(6)].map((b) => alphabet[b % alphabet.length]).join('');
  } while (rooms.has(code));
  const room = {
    code, game: null, seats: { w: null, g: null, b: null }, chat: [], timeControl, clock: null, updatedAt: Date.now(),
  };
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
  const takeback = room.takeback && {
    by: room.undo.by,
    voters: room.takeback.voters,
    accepted: room.takeback.accepted,
    expiresIn: Math.max(0, room.takeback.expiresAt - Date.now()),
  };
  // Times are as of sending, and the browser counts down the running one from there.
  const clock = room.clock && room.game && {
    left: timeLeft(room.clock, room.game, Date.now()),
    running: runningColor(room.clock, room.game),
  };
  for (const [socket, color] of connected) {
    send(socket, {
      type: 'room', code: room.code, you: color, players, game: room.game, timeControl: room.timeControl, clock,
      takeback, canTakeBack: Boolean(color) && canTakeBack(room, color), isHost: isHost(room, socket),
    });
  }
}

// Every change to a running game goes through here. It charges the turn that just ended
// to the clock, credits the increment to `mover`, and starts the next player's time.
// `update` gets the game and returns the new one, or throws to leave everything as it was.
function updateGame(room, update, mover = null) {
  const now = Date.now();
  // A move arriving just after the time ran out must not beat the clock.
  flagIfOut(room, now);
  const before = room.game;
  // A takeback puts the clocks back to the moment the move was made, without its increment.
  const clockAtMove = room.clock && {
    ...structuredClone(room.clock), remaining: timeLeft(room.clock, before, now), paused: false,
  };
  const next = update(before);
  if (room.clock) settle(room.clock, before, now, mover);
  room.game = next;
  movedOn(room);
  if (mover && next.history) {
    room.undo = { by: mover, game: before, clock: clockAtMove, step: next.history.length, asked: false };
  }
  gameChanged(room);
}

// The game changed, so the last move can no longer be taken back, and a request to
// take it back is declined.
function movedOn(room) {
  room.undo = null;
  endTakeback(room, 'The game moved on, so the takeback was declined');
}

// Clears a pending request that didn't go through, restarting the clock of a player on
// move who had paused it by agreeing.
function endTakeback(room, notice) {
  if (!room.takeback) return;
  clearTimeout(takebackTimers.get(room.code));
  takebackTimers.delete(room.code);
  room.takeback = null;
  resume(room.clock, Date.now());
  scheduleFlag(room);
  notify(room, notice);
}

function scheduleTakebackExpiry(room, ms) {
  const request = room.takeback;
  request.expiresAt = Date.now() + ms;
  clearTimeout(takebackTimers.get(room.code));
  takebackTimers.set(room.code, setTimeout(() => {
    if (room.takeback !== request) return;
    endTakeback(room, 'Not everyone answered in time, so the takeback was declined');
    touch(room);
    broadcast(room);
  }, ms));
}

function notify(room, text) {
  for (const client of sockets.get(room.code)?.keys() ?? []) send(client, { type: 'notice', text });
}

// You can ask once, for your own move, until the next action in the game.
function canTakeBack(room, color) {
  const { undo } = room;
  return Boolean(undo) && undo.by === color && !undo.asked && room.game.history?.length === undo.step;
}

function gameChanged(room) {
  scheduleFlag(room);
  touch(room);
  broadcast(room);
}

// Knocks out the player on move if their time is up. Returns whether it did.
function flagIfOut(room, now) {
  if (!room.clock || !hasFlagged(room.clock, room.game, now)) return false;
  const color = runningColor(room.clock, room.game);
  settle(room.clock, room.game, now);
  room.game = timeOut(room.game, color);
  movedOn(room);
  gameChanged(room);
  return true;
}

function scheduleFlag(room) {
  clearTimeout(flagTimers.get(room.code));
  flagTimers.delete(room.code);
  const color = room.clock && runningColor(room.clock, room.game);
  if (!color) return;
  const ms = timeLeft(room.clock, room.game, Date.now())[color];
  flagTimers.set(room.code, setTimeout(() => {
    if (!flagIfOut(room, Date.now())) scheduleFlag(room);
  }, ms + 20));
}

// Whether this connection is the room's creator. Rooms saved before creators were tracked
// have no host token, so there any seated player counts as one, or nobody could start them.
function isHost(room, socket) {
  if (!room.hostToken) return Boolean(sockets.get(room.code)?.get(socket));
  return socket.hostOf === room.code;
}

// What players see of a chat message: nothing marks one posted under a made-up name.
const publicChat = ({ color, name, text }) => ({ color, name, text });

// Names are shown as text, never as HTML, so only their length needs limiting.
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
  // The time control given here is only a starting point: the creator can change it in the lobby.
  create(socket, { timeControl }) {
    const room = newRoom(parseTimeControl(timeControl));
    room.hostToken = randomBytes(24).toString('hex');
    attach(socket, room, null);
    socket.hostOf = room.code;
    send(socket, { type: 'host', code: room.code, token: room.hostToken });
    broadcast(room);
  },

  // Open a room, retaking a seat if the token matches one, and the creator's
  // say over the clock if the host token does.
  join(socket, { code, token, hostToken }) {
    const room = rooms.get(String(code ?? '').toUpperCase());
    if (!room) throw new Error('That game does not exist');
    const color = COLORS.find((c) => token && room.seats[c]?.token === token) ?? null;
    attach(socket, room, color);
    socket.hostOf = hostToken && room.hostToken === hostToken ? room.code : null;
    send(socket, { type: 'chatHistory', messages: room.chat.map(publicChat) });
    broadcast(room);
  },

  setTimeControl(socket, { timeControl }) {
    const room = socket.room;
    if (!room || !isHost(room, socket)) throw new Error('Only whoever created the game can change the clock');
    if (room.game) throw new Error('The game has already started');
    room.timeControl = parseTimeControl(timeControl);
    touch(room);
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
    touch(room);
    broadcast(room);
  },

  // The creator starts the game once every seat is taken.
  start(socket) {
    const room = socket.room;
    if (!room || !isHost(room, socket)) throw new Error('Only whoever created the game can start it');
    if (room.game) throw new Error('The game has already started');
    if (!COLORS.every((c) => room.seats[c])) throw new Error('Wait until all three seats are taken');
    room.game = createGame();
    if (room.timeControl) room.clock = createClock(room.timeControl, Date.now());
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
    updateGame(room, (game) => {
      if (game.turn !== color) throw new Error('It is not your turn');
      return applyMove(game, { from, to, promotion });
    }, color);
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

  // Asks the others to let you take back your last move. Everyone still in the game before
  // that move gets a vote, including anyone it knocked out.
  takeback(socket) {
    const room = socket.room;
    const color = room && sockets.get(room.code).get(socket);
    if (!room?.game || !color) throw new Error('You are not playing in this game');
    if (!canTakeBack(room, color)) throw new Error('You can only ask once, before the next move');
    room.undo.asked = true;
    room.takeback = { voters: COLORS.filter((c) => c !== color && room.undo.game.alive[c]), accepted: [] };
    scheduleTakebackExpiry(room, TAKEBACK_TIMEOUT_MS);
    touch(room);
    broadcast(room);
  },

  answerTakeback(socket, { accept }) {
    const room = socket.room;
    const color = room && sockets.get(room.code).get(socket);
    const request = room?.takeback;
    if (!request || !request.voters.includes(color)) throw new Error('There is nothing for you to answer');
    if (request.accepted.includes(color)) throw new Error('You already agreed');
    const name = (c) => room.seats[c].name;
    if (!accept) {
      endTakeback(room, `${name(color)} declined the takeback`);
    } else {
      request.accepted.push(color);
      if (request.accepted.length === request.voters.length) {
        const { by, game, clock } = room.undo;
        clearTimeout(takebackTimers.get(room.code));
        takebackTimers.delete(room.code);
        room.game = game;
        if (clock) room.clock = { ...clock, since: Date.now(), paused: false };
        room.undo = null;
        room.takeback = null;
        notify(room, `${name(by)}'s move was taken back`);
        scheduleFlag(room);
      } else if (room.clock && runningColor(room.clock, room.game) === color) {
        // The player on move agreed, so their clock waits for the others.
        pause(room.clock, room.game, Date.now());
        scheduleFlag(room);
      }
    }
    touch(room);
    broadcast(room);
  },

  // Leaving for the home screen: the seat stays yours, but you show as offline.
  leave(socket) {
    socket.hostOf = null;
    detach(socket);
  },

  resign(socket) {
    const room = socket.room;
    const color = room && sockets.get(room.code).get(socket);
    if (!room?.game || !color) throw new Error('You are not playing in this game');
    updateGame(room, (game) => resign(game, color));
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
