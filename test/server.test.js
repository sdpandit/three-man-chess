import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';
import { sq } from '../shared/engine.js';

const dir = mkdtempSync(path.join(tmpdir(), 'tpc-'));
const dataFile = path.join(dir, 'games.json');
const PORT = 3977;

async function startServer() {
  const child = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, PORT, DATA_FILE: dataFile, TAKEBACK_TIMEOUT_MS: '1000' },
    stdio: 'pipe',
  });
  await new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => { if (String(d).includes('running')) resolve(); });
    child.on('exit', () => reject(new Error('server exited')));
  });
  return child;
}

async function stopServer(child) {
  child.removeAllListeners('exit');
  const gone = new Promise((resolve) => child.on('exit', resolve));
  child.kill();
  await gone;
}

// A small client that lets a test await the next message matching a condition.
async function client() {
  const ws = new WebSocket(`ws://localhost:${PORT}`);
  const inbox = [];
  const waiters = [];
  ws.on('message', (data) => {
    inbox.push(JSON.parse(data));
    for (const waiter of waiters.splice(0)) waiter();
  });
  await new Promise((resolve) => ws.on('open', resolve));
  return {
    ws,
    send: (message) => ws.send(JSON.stringify(message)),
    async until(check) {
      for (;;) {
        const index = inbox.findIndex(check);
        if (index >= 0) return inbox.splice(0, index + 1).at(-1);
        await Promise.race([
          new Promise((resolve) => waiters.push(resolve)),
          sleep(3000).then(() => { throw new Error('timed out waiting for message'); }),
        ]);
      }
    },
  };
}

test('three clients play a game; the server enforces the rules and survives a restart', async () => {
  let server = await startServer();
  try {
    assert.equal((await fetch(`http://localhost:${PORT}/engine.js`)).status, 200);
    assert.equal((await fetch(`http://localhost:${PORT}/../package.json`)).status, 404);
    assert.equal((await fetch(`http://localhost:${PORT}/server/index.js`)).status, 404);

    const [w, g, b, watcher] = await Promise.all([client(), client(), client(), client()]);
    w.send({ type: 'create' });
    const { code } = await w.until((m) => m.type === 'room');
    assert.match(code, /^[A-Z0-9]{6}$/);

    for (const c of [g, b, watcher]) {
      c.send({ type: 'join', code });
      await c.until((m) => m.type === 'room');
    }

    w.send({ type: 'sit', color: 'w', name: 'Ann' });
    const { token: whiteToken } = await w.until((m) => m.type === 'seat');
    g.send({ type: 'sit', color: 'w', name: 'Thief' });
    assert.match((await g.until((m) => m.type === 'error')).message, /taken/);
    g.send({ type: 'sit', color: 'g', name: '<b>Bo</b>' });
    await g.until((m) => m.type === 'seat');
    // Only the creator starts the game, and only with every seat taken.
    w.send({ type: 'start' });
    assert.match((await w.until((m) => m.type === 'error')).message, /all three seats/);
    b.send({ type: 'sit', color: 'b', name: 'Cy' });
    await b.until((m) => m.type === 'seat');
    const full = await watcher.until((m) => m.type === 'room' && m.players.b);
    assert.equal(full.game, null, 'filling the seats does not start the game');
    g.send({ type: 'start' });
    assert.match((await g.until((m) => m.type === 'error')).message, /Only whoever created/);
    w.send({ type: 'start' });

    const started = await watcher.until((m) => m.type === 'room' && m.game);
    assert.equal(started.you, null);
    assert.equal(JSON.stringify(started).includes(whiteToken), false, 'tokens are never broadcast');

    // Wrong player, spectator, illegal move.
    g.send({ type: 'move', from: sq(1, 8), to: sq(2, 8) });
    assert.match((await g.until((m) => m.type === 'error')).message, /not your turn/);
    watcher.send({ type: 'move', from: sq(1, 0), to: sq(2, 0) });
    assert.match((await watcher.until((m) => m.type === 'error')).message, /not playing/);
    w.send({ type: 'move', from: sq(1, 0), to: sq(5, 0) });
    assert.match((await w.until((m) => m.type === 'error')).message, /Illegal/);

    w.send({ type: 'move', from: sq(1, 0), to: sq(2, 0) });
    const moved = await g.until((m) => m.type === 'room' && m.game?.turn === 'g');
    assert.equal(moved.game.board[sq(2, 0)].color, 'w');
    assert.deepEqual(moved.game.history, [{ from: sq(1, 0), to: sq(2, 0), logEnd: 1 }]);

    // Chat reaches everyone, and only seated players can write in it.
    w.send({ type: 'chat', text: '  <b>nice move</b>  ' });
    const said = await watcher.until((m) => m.type === 'chat');
    assert.deepEqual(said.message, { color: 'w', name: 'Ann', text: '<b>nice move</b>' });
    await g.until((m) => m.type === 'chat');
    watcher.send({ type: 'chat', text: 'hello' });
    assert.match((await watcher.until((m) => m.type === 'error')).message, /Only players/);
    await sleep(300);
    g.send({ type: 'chat', text: 'x'.repeat(1000) });
    assert.equal((await b.until((m) => m.type === 'chat' && m.message.color === 'g')).message.text.length, 300);
    g.send({ type: 'chat', text: 'too fast' });
    assert.match((await g.until((m) => m.type === 'error')).message, /Slow down/);
    await sleep(300);
    b.send({ type: 'chat', text: '   ' });
    b.send({ type: 'chat', text: 'after blank' });
    assert.equal((await w.until((m) => m.type === 'chat' && m.message.color === 'b')).message.text, 'after blank');

    // The admin endpoint posts under any name, and only with the token.
    const adminChat = (body, token = readFileSync(path.join(dir, 'admin-token'), 'utf8')) =>
      fetch(`http://localhost:${PORT}/admin/chat`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
    assert.equal((await adminChat({ room: code, name: 'Jack', text: 'hi' }, 'wrong')).status, 403);
    assert.equal((await adminChat({ room: 'NOPE00', name: 'Jack', text: 'hi' })).status, 404);
    assert.equal((await adminChat({ room: code.toLowerCase(), name: 'Jack', text: 'yo', color: 'b' })).status, 200);
    const jack = await watcher.until((m) => m.type === 'chat' && m.message.name === 'Jack');
    assert.deepEqual(jack.message, { color: 'b', name: 'Jack', text: 'yo' }, 'nothing marks it as made up');

    // Players can rename themselves mid-game, and their past chat follows, but not
    // messages posted under a made-up name. Spectators can't, and empty names fall back.
    b.send({ type: 'rename', name: '  Cyrus  ' });
    assert.equal((await watcher.until((m) => m.type === 'room' && m.players.b.name !== 'Cy')).players.b.name, 'Cyrus');
    const renamedChat = await watcher.until((m) => m.type === 'chatHistory');
    assert.deepEqual(renamedChat.messages.filter((m) => m.color === 'b').map((m) => m.name), ['Cyrus', 'Jack']);
    watcher.send({ type: 'rename', name: 'Sneaky' });
    assert.match((await watcher.until((m) => m.type === 'error')).message, /Take a seat/);
    g.send({ type: 'rename', name: '   ' });
    assert.equal((await w.until((m) => m.type === 'room' && m.players.g.name !== '<b>Bo</b>')).players.g.name, 'Player');
    g.send({ type: 'rename', name: '<b>Bo</b>' });
    await w.until((m) => m.type === 'room' && m.players.g.name === '<b>Bo</b>');

    // Garbage must only produce an error.
    w.ws.send('not json');
    await w.until((m) => m.type === 'error');
    w.send({ type: '__proto__' });
    await w.until((m) => m.type === 'error');

    await sleep(800); // let the save timer fire
    assert.ok(existsSync(dataFile));
    for (const c of [w, g, b, watcher]) c.ws.close();
    await stopServer(server);
    server = await startServer();

    // Reconnecting with the token gets the seat and the game back.
    const back = await client();
    back.send({ type: 'join', code, token: whiteToken });
    const history = await back.until((m) => m.type === 'chatHistory');
    assert.deepEqual(history.messages.map((m) => m.name), ['Ann', '<b>Bo</b>', 'Cyrus', 'Jack'], 'chat survives a restart');
    assert.equal(JSON.stringify(history).includes(whiteToken), false);
    const restored = await back.until((m) => m.type === 'room');
    assert.equal(restored.you, 'w');
    assert.equal(restored.players.b.name, 'Cyrus', 'renames survive a restart');
    assert.equal(restored.game.turn, 'g');
    assert.equal(restored.game.board[sq(2, 0)].color, 'w');

    const stranger = await client();
    stranger.send({ type: 'join', code, token: 'wrong' });
    assert.equal((await stranger.until((m) => m.type === 'room')).you, null);

    back.send({ type: 'resign' });
    const resigned = await stranger.until((m) => m.type === 'room' && m.game && !m.game.alive.w);
    assert.equal(resigned.players.g.name, '<b>Bo</b>');
    back.ws.close();
    stranger.ws.close();
  } finally {
    await stopServer(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('clocks: players time out on their own turn, after their first move', async () => {
  const server = await startServer();
  try {
    const [w, g, b] = await Promise.all([client(), client(), client()]);
    w.send({ type: 'create', timeControl: { minutes: 90 / 0 } });
    assert.match((await w.until((m) => m.type === 'error')).message, /minutes/);
    w.send({ type: 'create', timeControl: null });
    const { token: hostToken } = await w.until((m) => m.type === 'host');
    const lobby = await w.until((m) => m.type === 'room');
    assert.equal(lobby.timeControl, null);
    assert.equal(lobby.isHost, true);
    for (const c of [g, b]) {
      c.send({ type: 'join', code: lobby.code });
      assert.equal((await c.until((m) => m.type === 'room')).isHost, false);
    }

    // Only the creator sets the clock, in the lobby. They keep that after reconnecting.
    g.send({ type: 'setTimeControl', timeControl: { minutes: 5, increment: 0 } });
    assert.match((await g.until((m) => m.type === 'error')).message, /Only whoever created/);
    w.ws.close();
    const host = await client();
    host.send({ type: 'join', code: lobby.code, hostToken });
    assert.equal((await host.until((m) => m.type === 'room')).isHost, true);
    host.send({ type: 'setTimeControl', timeControl: { minutes: 0, increment: 0 } });
    assert.match((await host.until((m) => m.type === 'error')).message, /minutes/);
    // 0.01 minutes is 600 ms each, with no increment.
    host.send({ type: 'setTimeControl', timeControl: { minutes: 0.01, increment: 0 } });
    const set = await g.until((m) => m.type === 'room' && m.timeControl);
    assert.deepEqual(set.timeControl, { minutes: 0.01, increment: 0 });

    for (const [c, color] of [[g, 'g'], [b, 'b'], [host, 'w']]) {
      c.send({ type: 'sit', color });
      await c.until((m) => m.type === 'seat');
    }
    host.send({ type: 'start' });
    const started = await host.until((m) => m.type === 'room' && m.game);
    host.send({ type: 'start' });
    assert.match((await host.until((m) => m.type === 'error')).message, /already started/);
    assert.deepEqual(started.clock, { left: { w: 600, g: 600, b: 600 }, running: null });
    host.send({ type: 'setTimeControl', timeControl: null });
    assert.match((await host.until((m) => m.type === 'error')).message, /already started/);

    // First moves are free, so taking longer than the whole clock is fine.
    await sleep(700);
    host.send({ type: 'move', from: sq(1, 0), to: sq(2, 0) });
    await g.until((m) => m.type === 'room' && m.game?.turn === 'g');
    g.send({ type: 'move', from: sq(1, 8), to: sq(2, 8) });
    await b.until((m) => m.type === 'room' && m.game?.turn === 'b');
    b.send({ type: 'move', from: sq(1, 16), to: sq(2, 16) });
    const timed = await host.until((m) => m.type === 'room' && m.game?.turn === 'w');
    assert.equal(timed.clock.running, 'w');

    // White's second move is timed. Nobody moves, so white and then gray run out.
    const whiteOut = await b.until((m) => m.type === 'room' && m.game && !m.game.alive.w);
    assert.equal(whiteOut.game.log.at(-1), 'White times out');
    assert.equal(whiteOut.clock.left.w, 0);
    assert.equal(whiteOut.clock.running, 'g');
    const over = await b.until((m) => m.type === 'room' && m.game?.status === 'won');
    assert.equal(over.game.winner, 'b');
    assert.equal(over.clock.running, null);
    assert.deepEqual(over.game.history.slice(-2).map((a) => a.timeOut), ['w', 'g']);

    // Returning to the lobby leaves the game: the seat stays, shown as offline.
    host.send({ type: 'leave' });
    const left = await b.until((m) => m.type === 'room' && m.players.w.online === false);
    assert.equal(left.players.w.name, 'Player');
    for (const c of [host, g, b]) c.ws.close();
  } finally {
    await stopServer(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('takebacks: ask once, everyone else agrees, and the next move declines it', async () => {
  const server = await startServer();
  try {
    const [w, g, b, watcher] = await Promise.all([client(), client(), client(), client()]);
    const everyone = [w, g, b, watcher];
    w.send({ type: 'create', timeControl: { minutes: 1, increment: 5 } });
    const { code } = await w.until((m) => m.type === 'room');
    for (const c of [g, b, watcher]) {
      c.send({ type: 'join', code });
      await c.until((m) => m.type === 'room');
    }
    for (const [c, color] of [[w, 'w'], [g, 'g'], [b, 'b']]) {
      c.send({ type: 'sit', color });
      await c.until((m) => m.type === 'seat');
    }
    w.send({ type: 'start' });
    const latest = (c, check = () => true) => c.until((m) => m.type === 'room' && m.game && check(m));
    const move = async (c, from, to) => {
      c.send({ type: 'move', from, to });
      return latest(watcher, (m) => m.game.board[to]);
    };
    const notice = (c, text) => c.until((m) => m.type === 'notice' && text.test(m.text));

    // Only the player who just moved can ask, and only once.
    await move(w, sq(1, 0), sq(2, 0));
    assert.equal((await latest(w, (m) => m.game.board[sq(2, 0)])).canTakeBack, true);
    g.send({ type: 'takeback' });
    assert.match((await g.until((m) => m.type === 'error')).message, /only ask once/);
    w.send({ type: 'takeback' });
    const asked = await latest(watcher, (m) => m.takeback);
    const { expiresIn, ...request } = asked.takeback;
    assert.deepEqual(request, { by: 'w', voters: ['g', 'b'], accepted: [] });
    assert.ok(expiresIn > 0);
    w.send({ type: 'takeback' });
    assert.match((await w.until((m) => m.type === 'error')).message, /only ask once/);
    w.send({ type: 'answerTakeback', accept: true });
    assert.match((await w.until((m) => m.type === 'error')).message, /nothing for you/);
    watcher.send({ type: 'answerTakeback', accept: true });
    assert.match((await watcher.until((m) => m.type === 'error')).message, /nothing for you/);

    // One yes and one no is a no, and the move stands.
    g.send({ type: 'answerTakeback', accept: true });
    assert.deepEqual((await latest(watcher, (m) => m.takeback?.accepted.length)).takeback.accepted, ['g']);
    b.send({ type: 'answerTakeback', accept: false });
    for (const c of everyone) await notice(c, /declined the takeback/);
    const declined = await latest(w, (m) => !m.takeback);
    assert.equal(declined.canTakeBack, false, 'no second request for the same move');
    assert.equal(declined.game.turn, 'g');

    // The next move declines a pending request.
    await move(g, sq(1, 8), sq(2, 8));
    g.send({ type: 'takeback' });
    await latest(watcher, (m) => m.takeback?.by === 'g');
    w.send({ type: 'answerTakeback', accept: true });
    await latest(watcher, (m) => m.takeback?.accepted.length === 1);
    b.send({ type: 'move', from: sq(1, 16), to: sq(2, 16) });
    for (const c of everyone) await notice(c, /moved on/);
    assert.equal((await latest(g, (m) => m.game.turn === 'w')).takeback, null);

    // White's second move is timed. Taking it back returns the time to when it was made,
    // without the increment, and white's clock runs again.
    const before = await latest(watcher, (m) => m.game.turn === 'w');
    // White's clock is already running, so a few milliseconds may have gone.
    assert.ok(before.clock.left.w > 59900 && before.clock.left.w <= 60000, 'the first move earned no increment');
    await sleep(300);
    const moved = await move(w, sq(1, 1), sq(2, 1));
    assert.ok(moved.clock.left.w > 60000, 'the second move earned the increment');
    w.send({ type: 'takeback' });
    g.send({ type: 'answerTakeback', accept: true });
    await latest(watcher, (m) => m.takeback?.accepted.length === 1);
    b.send({ type: 'answerTakeback', accept: true });
    for (const c of everyone) await notice(c, /move was taken back/);
    const undone = await latest(watcher, (m) => !m.game.board[sq(2, 1)]);
    assert.equal(undone.game.turn, 'w');
    assert.equal(undone.game.history.length, before.game.history.length);
    assert.deepEqual(undone.game.log, before.game.log);
    assert.equal(undone.clock.running, 'w');
    assert.ok(undone.clock.left.w < 60000 - 250 && undone.clock.left.w > 60000 - 1000, `white has ${undone.clock.left.w}`);
    assert.equal(undone.clock.left.g, 60000, 'gray gets back the time that ran during the request');
    assert.equal(undone.takeback, null);
    assert.equal((await latest(w, (m) => !m.game.board[sq(2, 1)])).canTakeBack, false);
    for (const c of everyone) c.ws.close();
  } finally {
    await stopServer(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('takebacks: the player on move pauses their clock by agreeing, and requests time out', async () => {
  const server = await startServer();
  try {
    const [w, g, b] = await Promise.all([client(), client(), client()]);
    w.send({ type: 'create', timeControl: { minutes: 1, increment: 0 } });
    const { code } = await w.until((m) => m.type === 'room');
    for (const c of [g, b]) {
      c.send({ type: 'join', code });
      await c.until((m) => m.type === 'room');
    }
    for (const [c, color] of [[w, 'w'], [g, 'g'], [b, 'b']]) {
      c.send({ type: 'sit', color });
      await c.until((m) => m.type === 'seat');
    }
    w.send({ type: 'start' });
    const latest = (c, check) => c.until((m) => m.type === 'room' && m.game && check(m));
    // First moves for everyone, then white's timed second move.
    for (const [c, from, to, next] of [[w, sq(1, 0), sq(2, 0), 'g'], [g, sq(1, 8), sq(2, 8), 'b'],
      [b, sq(1, 16), sq(2, 16), 'w'], [w, sq(1, 1), sq(2, 1), 'g']]) {
      c.send({ type: 'move', from, to });
      await latest(b, (m) => m.game.turn === next && m.game.board[to]);
    }

    // Gray is on move and agrees, so gray's clock stops while black decides.
    w.send({ type: 'takeback' });
    const asked = await latest(b, (m) => m.takeback);
    assert.ok(asked.takeback.expiresIn > 900 && asked.takeback.expiresIn <= 1000);
    assert.equal(asked.clock.running, 'g');
    g.send({ type: 'answerTakeback', accept: true });
    const paused = await latest(b, (m) => m.takeback?.accepted.length === 1);
    assert.equal(paused.clock.running, null);

    // Black never answers, so the request runs out, and gray's clock carries on from where it stopped.
    await sleep(400);
    for (const c of [w, g, b]) await c.until((m) => m.type === 'notice' && /in time/.test(m.text));
    const expired = await latest(b, (m) => !m.takeback);
    assert.equal(expired.clock.running, 'g');
    assert.ok(paused.clock.left.g - expired.clock.left.g < 100, 'no time was charged during the pause');
    assert.equal(expired.game.turn, 'g', 'the move stands');

    // A no also restarts the clock of the player on move who had agreed.
    g.send({ type: 'move', from: sq(1, 9), to: sq(2, 9) });
    await latest(b, (m) => m.game.turn === 'b' && m.game.board[sq(2, 9)]);
    g.send({ type: 'takeback' });
    await latest(w, (m) => m.takeback);
    b.send({ type: 'answerTakeback', accept: true });
    const blackPaused = await latest(w, (m) => m.takeback?.accepted.length === 1);
    assert.equal(blackPaused.clock.running, null);
    await sleep(300);
    w.send({ type: 'answerTakeback', accept: false });
    await b.until((m) => m.type === 'notice' && /declined/.test(m.text));
    const resumed = await latest(w, (m) => !m.takeback);
    assert.equal(resumed.clock.running, 'b');
    assert.ok(blackPaused.clock.left.b - resumed.clock.left.b < 100, 'no time was charged during the pause');
    for (const c of [w, g, b]) c.ws.close();
  } finally {
    await stopServer(server);
    rmSync(dir, { recursive: true, force: true });
  }
});
