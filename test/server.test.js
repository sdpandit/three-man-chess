import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
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
    env: { ...process.env, PORT, DATA_FILE: dataFile },
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
    b.send({ type: 'sit', color: 'b', name: 'Cy' });
    await b.until((m) => m.type === 'seat');

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
    assert.deepEqual(history.messages.map((m) => m.color), ['w', 'g', 'b'], 'chat survives a restart');
    assert.equal(JSON.stringify(history).includes(whiteToken), false);
    const restored = await back.until((m) => m.type === 'room');
    assert.equal(restored.you, 'w');
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
