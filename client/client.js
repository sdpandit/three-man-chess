import {
  RANKS, FILES, SQUARES, COLORS, COLOR_NAMES, PROMOTIONS,
  rankOf, fileOf, isLightSquare, legalMoves, isInCheck, createGame, applyMove, resign, replayAction,
} from './engine.js';

const $ = (id) => document.getElementById(id);
const SVG_NS = 'http://www.w3.org/2000/svg';
const OUTER_RADIUS = 380;
const HOLE_RADIUS = 110;
const RING_WIDTH = (OUTER_RADIUS - HOLE_RADIUS) / RANKS;
const GLYPHS = { K: '♚', Q: '♛', R: '♜', B: '♝', N: '♞', P: '♟' };
// U+FE0E asks for the text form, otherwise some systems draw the pawn as an emoji.
const glyph = (type) => `${GLYPHS[type]}︎`;
// The file at the middle of each player's sector, used to turn their side to the bottom.
const SECTOR_MIDDLE = { w: 3.5, g: 11.5, b: 19.5 };

let socket = null;
// Solo mode runs entirely in this page: one person plays all three colours.
let solo = false;
let room = null;
let selected = null;
let pendingPromotion = null;
// The past position on show, as a number of actions from the start. Null is the live game.
let viewStep = null;
// Past positions replayed so far, kept so stepping through them stays instant.
let positions = [];
let toastTimer = null;

const tokenKey = (code) => `tpc-token-${code}`;
const roomCodeFromUrl = () => new URL(location.href).searchParams.get('room')?.toUpperCase() ?? null;

function startSolo() {
  solo = true;
  const players = Object.fromEntries(COLORS.map((color, i) => [color, { name: `Player ${i + 1}`, online: true }]));
  room = { code: null, you: 'w', players, game: createGame() };
  viewStep = null;
  positions = [];
  renderGame();
}

function playSolo(message) {
  try {
    const { game } = room;
    room.game = message.type === 'resign' ? resign(game, game.turn) : applyMove(game, message);
    room.you = room.game.turn;
  } catch (err) {
    toast(err.message);
  }
  selected = null;
  pendingPromotion = null;
  viewStep = null;
  rememberLivePosition();
  renderGame();
}

// Takes back the latest action. Solo mode only: online, the server owns the game.
function undoSolo() {
  const step = room.game.history.length - 1;
  if (!solo || step < 0) return;
  room.game = positionAt(step);
  positions.length = step + 1;
  room.you = room.game.turn;
  selected = null;
  pendingPromotion = null;
  viewStep = null;
  renderGame();
}

function send(message) {
  if (solo) {
    playSolo(message);
    return;
  }
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  else toast('Not connected, retrying...');
}

function toast(text) {
  $('toast').textContent = text;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4000);
}

function joinRoom(code) {
  send({ type: 'join', code, token: localStorage.getItem(tokenKey(code)) });
}

function connect() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(`${protocol}//${location.host}`);
  socket.onopen = () => {
    if (solo) return;
    const code = room?.code ?? roomCodeFromUrl();
    if (code) joinRoom(code);
    else show('home');
  };
  socket.onclose = () => {
    setTimeout(connect, 1500);
  };
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.type === 'error') {
      toast(message.message);
      if (!room) {
        history.replaceState(null, '', location.pathname);
        show('home');
      }
    } else if (message.type === 'seat') {
      localStorage.setItem(tokenKey(message.code), message.token);
    } else if (message.type === 'room') {
      receiveRoom(message);
    } else if (message.type === 'chatHistory') {
      $('chat-messages').replaceChildren();
      message.messages.forEach(addChatMessage);
    } else if (message.type === 'chat') {
      addChatMessage(message.message);
    }
  };
}

function show(view) {
  for (const id of ['home', 'lobby', 'game']) $(id).hidden = id !== view;
}

function receiveRoom(message) {
  // Someone connecting or dropping out shouldn't clear a half-made move.
  if (room?.game?.log.length !== message.game?.log.length) {
    selected = null;
    pendingPromotion = null;
  }
  if (room?.code !== message.code) {
    viewStep = null;
    positions = [];
  }
  room = message;
  rememberLivePosition();
  const url = new URL(location.href);
  if (url.searchParams.get('room') !== room.code) {
    url.search = `?room=${room.code}`;
    history.replaceState(null, '', url);
  }
  if (room.game) renderGame();
  else renderLobby();
}

// ---- Lobby ----

function renderLobby() {
  show('lobby');
  $('share-link').value = `${location.origin}${location.pathname}?room=${room.code}`;
  const seats = $('seats');
  seats.replaceChildren();
  for (const color of COLORS) {
    const row = document.createElement('div');
    row.className = 'seat';
    row.append(colorLabel(color));
    const player = room.players[color];
    const right = document.createElement(player || room.you ? 'span' : 'button');
    if (player) {
      right.textContent = color === room.you ? `${player.name} (you)` : player.name;
    } else if (room.you) {
      right.textContent = 'Open';
    } else {
      right.textContent = 'Sit here';
      right.addEventListener('click', () => {
        localStorage.setItem('tpc-name', $('name').value);
        send({ type: 'sit', color, name: $('name').value });
      });
    }
    row.append(right);
    seats.append(row);
  }
  $('name').disabled = Boolean(room.you);
}

function colorLabel(color) {
  const label = document.createElement('span');
  const swatch = document.createElement('span');
  swatch.className = `swatch ${color}`;
  label.append(swatch, COLOR_NAMES[color]);
  return label;
}

// ---- Board drawing ----

function svgEl(name, attrs = {}) {
  const el = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  return el;
}

// In solo mode the view stays put rather than spinning every turn.
const viewOffset = () => SECTOR_MIDDLE[solo ? 'w' : room.you ?? 'w'];
// Each player sees their own sector at the bottom of the board.
function fileAngle(file) {
  return ((file - viewOffset()) / FILES) * 2 * Math.PI + Math.PI / 2;
}
function polar(radius, angle) {
  return [radius * Math.cos(angle), radius * Math.sin(angle)];
}
// Rank 0 is the outer ring.
const outerRadiusOf = (rank) => OUTER_RADIUS - rank * RING_WIDTH;

function cellPath(rank, file) {
  const outer = outerRadiusOf(rank);
  const inner = outer - RING_WIDTH;
  const a0 = fileAngle(file - 0.5);
  const a1 = fileAngle(file + 0.5);
  const [x0, y0] = polar(outer, a0);
  const [x1, y1] = polar(outer, a1);
  const [x2, y2] = polar(inner, a1);
  const [x3, y3] = polar(inner, a0);
  return `M${x0} ${y0}A${outer} ${outer} 0 0 1 ${x1} ${y1}L${x2} ${y2}A${inner} ${inner} 0 0 0 ${x3} ${y3}Z`;
}

function cellCentre(square) {
  const radius = outerRadiusOf(rankOf(square)) - RING_WIDTH / 2;
  return polar(radius, fileAngle(fileOf(square)));
}

function renderBoard() {
  const svg = $('board');
  svg.replaceChildren();
  const game = shownGame();
  const targets = selected === null || !isMyTurn()
    ? []
    : legalMoves(game, room.you, selected).map((m) => m.to);
  const kingsInCheck = new Set(game.status === 'active'
    ? COLORS.filter((c) => game.alive[c] && isInCheck(game, c))
      .map((c) => game.board.findIndex((p) => p?.color === c && p.type === 'K'))
    : []);

  svg.append(svgEl('circle', { class: 'rim', r: OUTER_RADIUS + 5 }));
  for (let square = 0; square < SQUARES; square++) {
    const rank = rankOf(square);
    const file = fileOf(square);
    const classes = ['cell', isLightSquare(square) ? 'light' : 'dark'];
    if (game.lastMove && (game.lastMove.from === square || game.lastMove.to === square)) classes.push('last');
    if (kingsInCheck.has(square)) classes.push('in-check');
    if (square === selected) classes.push('selected');
    const mine = isMyTurn() && game.board[square]?.color === room.you;
    if (mine || targets.includes(square)) classes.push('clickable');
    const cell = svgEl('path', { class: classes.join(' '), d: cellPath(rank, file), 'data-square': square });
    cell.addEventListener('click', () => clickSquare(square));
    svg.append(cell);
  }
  svg.append(svgEl('circle', { class: 'hole', r: HOLE_RADIUS }));

  for (const moat of game.moats) {
    const angle = fileAngle(moat - 0.5);
    const [x1, y1] = polar(OUTER_RADIUS + 5, angle);
    const [x2, y2] = polar(OUTER_RADIUS - RING_WIDTH, angle);
    svg.append(svgEl('line', { class: 'moat', x1, y1, x2, y2 }));
    const [x3, y3] = polar(OUTER_RADIUS - 3 * RING_WIDTH, angle);
    svg.append(svgEl('line', { class: 'thin-line', x1: x2, y1: y2, x2: x3, y2: y3 }));
  }

  // File letters round the outside so the move log can be followed.
  for (let file = 0; file < FILES; file++) {
    const [x, y] = polar(OUTER_RADIUS + 15, fileAngle(file));
    const label = svgEl('text', { class: 'coord', x, y });
    label.textContent = String.fromCharCode(97 + file);
    svg.append(label);
  }

  game.board.forEach((piece, square) => {
    if (!piece) return;
    const [x, y] = cellCentre(square);
    // Squares shrink toward the hole, and the pieces shrink with them.
    const size = Math.min(40, 0.98 * (2 * Math.PI * (outerRadiusOf(rankOf(square)) - RING_WIDTH / 2)) / FILES);
    const corpse = game.alive[piece.color] ? '' : ' corpse';
    const text = svgEl('text', { class: `piece ${piece.color}${corpse}`, x, y, 'font-size': size });
    text.textContent = glyph(piece.type);
    svg.append(text);
  });

  for (const square of new Set(targets)) {
    const [x, y] = cellCentre(square);
    const radius = outerRadiusOf(rankOf(square)) - RING_WIDTH / 2;
    const halfWidth = (Math.PI * radius) / FILES;
    svg.append(game.board[square]
      ? svgEl('circle', { class: 'capture-ring', cx: x, cy: y, r: halfWidth * 0.92 })
      : svgEl('circle', { class: 'dot', cx: x, cy: y, r: halfWidth * 0.34 }));
  }
}

const isMyTurn = () => viewStep === null && room?.game?.status === 'active' && room.game.turn === room.you;

function clickSquare(square) {
  if (!isMyTurn()) return;
  const { game } = room;
  if (selected !== null) {
    const matches = legalMoves(game, room.you, selected).filter((m) => m.to === square);
    if (matches.length > 1) {
      pendingPromotion = { from: selected, to: square };
      renderPanel();
      return;
    }
    if (matches.length === 1) {
      send({ type: 'move', from: selected, to: square });
      selected = null;
      renderGame();
      return;
    }
  }
  pendingPromotion = null;
  selected = game.board[square]?.color === room.you && square !== selected ? square : null;
  renderGame();
}

// ---- Move history ----

// Positions seen live never need replaying, so only joining mid-game has to.
function rememberLivePosition() {
  if (positions.length > 0 && positions.length === room.game?.history?.length) positions.push(room.game);
}

function positionAt(step) {
  if (positions.length === 0) positions.push(createGame());
  while (positions.length <= step) {
    positions.push(replayAction(positions.at(-1), room.game.history[positions.length - 1]));
  }
  return positions[step];
}

const shownGame = () => (viewStep === null ? room.game : positionAt(viewStep));
const currentStep = () => viewStep ?? room.game.history?.length ?? 0;

function goToStep(step) {
  const moves = room.game.history;
  if (!moves || step < 0 || step > moves.length) return;
  try {
    if (step < moves.length) positionAt(step);
    viewStep = step < moves.length ? step : null;
  } catch {
    toast('That position could not be rebuilt');
    return;
  }
  selected = null;
  pendingPromotion = null;
  renderGame();
}

// Moves are logged as "White: d2-d4" and shown with a coloured square for the name.
const colorOfLine = (line) => COLORS.find((c) => line.startsWith(`${COLOR_NAMES[c]}: `));

function fillLogLine(element, line) {
  const color = colorOfLine(line);
  if (!color) {
    element.textContent = line;
    return;
  }
  const square = document.createElement('span');
  square.className = `swatch log-square ${color}`;
  square.setAttribute('role', 'img');
  square.setAttribute('aria-label', COLOR_NAMES[color]);
  element.append(square, line.slice(COLOR_NAMES[color].length + 2));
}

function renderLog() {
  const game = room.game;
  const moves = game.history ?? [];
  const log = $('log');
  let index = 0;
  // One row per round, with a column for each colour. Events like a resignation
  // get a row of their own, and moves resume in their own column on the next.
  let row = 0;
  let lastColumn = Infinity;
  log.replaceChildren(...game.log.map((line, lineNumber) => {
    while (index < moves.length && moves[index].logEnd <= lineNumber) index++;
    const entry = document.createElement('li');
    const color = colorOfLine(line);
    const column = color ? COLORS.indexOf(color) : null;
    if (column === null || column <= lastColumn) row++;
    lastColumn = column ?? Infinity;
    entry.style.gridRow = row;
    entry.style.gridColumn = column === null ? '1 / -1' : column + 1;
    if (index === moves.length) {
      fillLogLine(entry, line);
      return entry;
    }
    const step = index + 1;
    const button = document.createElement('button');
    button.className = 'log-move';
    fillLogLine(button, line);
    button.addEventListener('click', () => goToStep(step));
    if (step === currentStep()) entry.className = 'current';
    entry.append(button);
    return entry;
  }));
  const current = log.querySelector('.current');
  log.scrollTop = viewStep === null || !current
    ? log.scrollHeight
    : current.offsetTop - log.clientHeight / 2;

  $('history-back').disabled = currentStep() === 0;
  $('history-start').disabled = currentStep() === 0;
  $('history-forward').disabled = viewStep === null;
  $('history-latest').disabled = viewStep === null;
  $('undo').disabled = !solo || !game.history?.length;
}

// ---- Chat ----

function addChatMessage({ color, name, text }) {
  const list = $('chat-messages');
  // Don't pull someone back down if they've scrolled up to read.
  const atBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 4;
  const entry = document.createElement('li');
  const swatch = document.createElement('span');
  swatch.className = `swatch ${color}`;
  const author = document.createElement('span');
  author.className = 'chat-name';
  author.textContent = `${name}: `;
  entry.append(swatch, author, text);
  list.append(entry);
  if (atBottom) list.scrollTop = list.scrollHeight;
}

// ---- Side panel ----

function viewingText() {
  const place = viewStep === 0 ? 'the starting position' : `move ${viewStep} of ${room.game.history.length}`;
  const waiting = room.game.status === 'active' && room.game.turn === room.you && !solo;
  return `Viewing ${place}${waiting ? '. It\'s your move in the live game' : ''}`;
}

function statusText() {
  if (viewStep !== null) return viewingText();
  const { game } = room;
  const you = solo ? null : room.you;
  const nameOf = (c) => room.players[c].name;
  if (game.status === 'won') {
    return game.winner === you ? 'You win!' : `${nameOf(game.winner)} (${COLOR_NAMES[game.winner]}) wins`;
  }
  if (game.status === 'draw') return 'Draw by stalemate';
  if (you && !game.alive[you]) return `You are out. ${nameOf(game.turn)} to move`;
  if (game.turn === you) return isInCheck(game, you) ? 'Your move: you are in check!' : 'Your move';
  return `${nameOf(game.turn)} (${COLOR_NAMES[game.turn]}) to move`;
}

function renderPanel() {
  const game = shownGame();
  $('status').textContent = statusText();
  $('status').className = viewStep !== null ? 'viewing' : isMyTurn() ? 'yours' : '';

  const list = $('players');
  list.replaceChildren();
  for (const color of COLORS) {
    const player = room.players[color];
    const item = document.createElement('li');
    if (game.status === 'active' && game.turn === color) item.className = 'turn';
    const swatch = document.createElement('span');
    swatch.className = `swatch ${color}`;
    const name = document.createElement('span');
    name.textContent = !solo && color === room.you ? `${player.name} (you)` : player.name;
    if (!game.alive[color]) name.className = 'dead';
    item.append(swatch, name);
    const addTag = (text, className) => {
      const tag = document.createElement('span');
      tag.className = className;
      tag.textContent = ` ${text}`;
      item.append(tag);
    };
    if (game.status === 'active' && game.alive[color] && isInCheck(game, color)) addTag('check', 'check');
    if (!player.online) addTag('offline', 'tag');
    list.append(item);
  }

  renderLog();

  $('promotion').hidden = !pendingPromotion;
  if (pendingPromotion) {
    $('promotion-options').replaceChildren(...PROMOTIONS.map((type) => {
      const button = document.createElement('button');
      button.textContent = glyph(type);
      button.setAttribute('aria-label', { Q: 'Queen', R: 'Rook', B: 'Bishop', N: 'Knight' }[type]);
      button.addEventListener('click', () => {
        send({ type: 'move', ...pendingPromotion, promotion: type });
        pendingPromotion = null;
        selected = null;
        renderGame();
      });
      return button;
    }));
  }

  const live = room.game;
  $('resign').disabled = !room.you || live.status !== 'active' || !live.alive[room.you];
}

function renderGame() {
  show('game');
  $('chat').hidden = solo;
  $('chat-form').hidden = !room.you;
  renderBoard();
  renderPanel();
}

// ---- Wiring ----

$('create').addEventListener('click', () => send({ type: 'create' }));
$('solo').addEventListener('click', startSolo);
$('join-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const code = $('join-code').value.trim().toUpperCase();
  if (code) joinRoom(code);
});
$('copy-link').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('share-link').value);
    $('copy-link').textContent = 'Copied';
    setTimeout(() => { $('copy-link').textContent = 'Copy'; }, 1500);
  } catch {
    $('share-link').select();
  }
});
$('resign').addEventListener('click', () => {
  if (!confirm('Resign? Your pieces stay on the board as corpses.')) return;
  viewStep = null;
  send({ type: 'resign' });
});
$('undo').addEventListener('click', undoSolo);
$('chat-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const text = $('chat-input').value.trim();
  if (!text) return;
  send({ type: 'chat', text });
  $('chat-input').value = '';
});
$('history-back').addEventListener('click', () => goToStep(currentStep() - 1));
$('history-forward').addEventListener('click', () => goToStep(currentStep() + 1));
$('history-start').addEventListener('click', () => goToStep(0));
$('history-latest').addEventListener('click', () => goToStep(room.game.history.length));
document.addEventListener('keydown', (event) => {
  if ($('game').hidden || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  if (event.target instanceof HTMLInputElement) return;
  const delta = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
  if (!delta) return;
  event.preventDefault();
  goToStep(currentStep() + delta);
});
$('name').value = localStorage.getItem('tpc-name') ?? '';

// GitHub Pages has no game server, so that copy of the site is only the analysis board.
if (location.hostname.endsWith('.github.io') || new URL(location.href).searchParams.has('solo')) startSolo();
else connect();
