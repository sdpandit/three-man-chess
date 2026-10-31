// Rules engine for three-player chess. Runs unchanged in Node and the browser.
//
// The board is a ring of 24 files and 6 ranks. Rank 0 is the outer edge and
// rank 5 borders the centre hole. A square is the index rank * 24 + file.
// State is plain JSON so it can be sent over the wire and saved to disk.

export const RANKS = 6;
export const FILES = 24;
export const SQUARES = RANKS * FILES;
export const COLORS = ['w', 'g', 'b'];
export const COLOR_NAMES = { w: 'White', g: 'Gray', b: 'Black' };
export const PROMOTIONS = ['Q', 'R', 'B', 'N'];

// King and queen are swapped from normal chess, which puts every king on a light square.
const BACK_ROW = ['R', 'N', 'B', 'K', 'Q', 'B', 'N', 'R'];
const SECTOR_START = { w: 0, g: 8, b: 16 };
const KING_FILE = 3;
// A moat is named by the file on its clockwise side: 0 lies between x and a.
const ALL_MOATS = [0, 8, 16];

const ORTHOGONALS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const DIAGONALS = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const ALL_DIRECTIONS = [...ORTHOGONALS, ...DIAGONALS];
const KNIGHT_JUMPS = [
  [2, 1], [2, -1], [-2, 1], [-2, -1],
  [1, 2], [1, -2], [-1, 2], [-1, -2],
];

export const sq = (rank, file) => rank * FILES + (((file % FILES) + FILES) % FILES);
export const rankOf = (square) => Math.floor(square / FILES);
export const fileOf = (square) => square % FILES;
export const isLightSquare = (square) => (rankOf(square) + fileOf(square)) % 2 === 1;
const wrapFile = (file) => ((file % FILES) + FILES) % FILES;

// Moats run along the back rank only, so a move can only meet one if it starts
// or ends there. That covers every case: sideways along the rank, a diagonal
// clipping the moat's inner corner, and a knight with either route over it.
function crossesMoat(moats, rank, file, dRank, dFile) {
  if (rank !== 0 && rank + dRank !== 0) return false;
  return crossesMoatLine(moats, file, dFile);
}

// The thin line carries on from a moat through the next two ranks and only stops
// captures by pawns heading inward. As with moats, a diagonal touching its inner
// end counts.
function crossesThinLine(moats, rank, file, dRank, dFile) {
  if (Math.min(rank, rank + dRank) > 2) return false;
  return crossesMoatLine(moats, file, dFile);
}

function crossesMoatLine(moats, file, dFile) {
  const dir = Math.sign(dFile);
  for (let i = 0; i < Math.abs(dFile); i++) {
    const near = file + i * dir;
    if (moats.includes(wrapFile(dir > 0 ? near + 1 : near))) return true;
  }
  return false;
}

// Files a-x, ranks 1 (outer edge) to 6 (next to the hole).
export function squareName(square) {
  return String.fromCharCode(97 + fileOf(square)) + (rankOf(square) + 1);
}

// One move from a square. Past rank 5 it only exists if it is given a file offset
// for crossing the hole: it carries on outward from rank 5 on the far side, so the
// returned rank direction is flipped.
function step(rank, file, dRank, dFile, crossOffset) {
  const nextRank = rank + dRank;
  if (nextRank < 0) return null;
  if (nextRank >= RANKS) {
    if (crossOffset === null) return null;
    return { rank: 2 * RANKS - 1 - nextRank, file: file + crossOffset, dRank: -dRank };
  }
  return { rank: nextRank, file: file + dFile, dRank };
}

// Files moved by crossing the hole. Straight lines go to the opposite file. A
// diagonal goes 14 files on, for pawns and kings as well as sliders, closing it into
// a loop of 12 squares: c1 d2 e3 f4 g5 h6 v6 w5 x4 a3 b2 and back to c1.
const crossingFiles = (dFile) => (dFile === 0 ? FILES / 2 : 14 * dFile);

// A loop's one back-rank square ends any move that reaches it, so no piece
// boomerangs off the back rank or laps the loop.
function slide({ board, moats }, from, directions, visit) {
  for (const [dRank, dFile] of directions) {
    let rank = rankOf(from);
    let file = fileOf(from);
    let dir = dRank;
    let crossed = false;
    for (;;) {
      if (crossesMoat(moats, rank, file, dir, dFile)) break;
      const next = step(rank, file, dir, dFile, crossingFiles(dFile));
      if (!next) break;
      if (dFile !== 0 && next.dRank !== dir) {
        // A back-rank square has two ways round its loop. If the direct way
        // crosses a moat, going the long way through the hole is no way round it.
        if (rankOf(from) === 0 && crossesMoat(moats, 0, fileOf(from), 1, -dFile)) break;
        crossed = true;
      }
      if (crossed && next.rank === 0 && crossesMoat(moats, 0, next.file, 1, dFile)) break;
      const target = sq(next.rank, next.file);
      // A sliding piece can run all the way round a ring or loop back to its start.
      if (target === from) break;
      visit(target);
      if (board[target]) break;
      ({ rank, file, dRank: dir } = next);
    }
  }
}

// Every square a piece attacks. A pawn's are its forward diagonals only.
function attackedSquares(state, from) {
  const piece = state.board[from];
  const rank = rankOf(from);
  const file = fileOf(from);
  const out = [];
  const visit = (target) => out.push(target);
  const hop = ([dRank, dFile], crossOffset) => {
    if (crossesMoat(state.moats, rank, file, dRank, dFile)) return;
    const next = step(rank, file, dRank, dFile, crossOffset);
    if (next) out.push(sq(next.rank, next.file));
  };

  switch (piece.type) {
    case 'R': slide(state, from, ORTHOGONALS, visit); break;
    case 'B': slide(state, from, DIAGONALS, visit); break;
    case 'Q': slide(state, from, ALL_DIRECTIONS, visit); break;
    case 'N':
      // A knight isn't a diagonal mover: it crosses straight over, then sideways.
      KNIGHT_JUMPS.forEach((jump) => hop(jump, FILES / 2 + jump[1]));
      break;
    case 'K': ALL_DIRECTIONS.forEach((dir) => hop(dir, crossingFiles(dir[1]))); break;
    case 'P': {
      const forward = piece.crossed ? -1 : 1;
      for (const dFile of [1, -1]) {
        if (piece.crossed || !crossesThinLine(state.moats, rank, file, forward, dFile)) hop([forward, dFile], crossingFiles(dFile));
      }
      break;
    }
  }
  // From the back rank, both ways round a diagonal loop reach the same squares.
  return [...new Set(out)];
}

export function createGame() {
  const board = new Array(SQUARES).fill(null);
  for (const color of COLORS) {
    BACK_ROW.forEach((type, i) => {
      const file = SECTOR_START[color] + i;
      board[sq(0, file)] = { color, type, moved: false, crossed: false };
      board[sq(1, file)] = { color, type: 'P', moved: false, crossed: false };
    });
  }
  return {
    board,
    turn: 'w',
    alive: { w: true, g: true, b: true },
    enPassant: [],
    moats: ALL_MOATS,
    status: 'active', // 'active' | 'won' | 'draw'
    winner: null,
    lastMove: null,
    log: [],
  };
}

function findKing(state, color) {
  return state.board.findIndex((p) => p && p.color === color && p.type === 'K');
}

// Corpses never attack, so only living opponents count.
function isAttacked(state, square, color) {
  return state.board.some((piece, from) =>
    piece && piece.color !== color && state.alive[piece.color]
    && attackedSquares(state, from).includes(square));
}

export function isInCheck(state, color) {
  return isAttacked(state, findKing(state, color), color);
}

// A living king is only ever capturable after a third player's move exposes it.
// Nothing else can leave it attacked on the attacker's turn: its owner must end
// their own move out of check, so a check that the attacker gave is always
// answered before the attacker moves again.
function canCapture(state, target, color) {
  const piece = state.board[target];
  return Boolean(piece) && piece.color !== color;
}

function capturesLivingKing(state, move) {
  const piece = state.board[move.to];
  return piece?.type === 'K' && state.alive[piece.color] ? piece.color : null;
}

function pawnMoves(state, from) {
  const piece = state.board[from];
  const rank = rankOf(from);
  const file = fileOf(from);
  const forward = piece.crossed ? -1 : 1;
  const moves = [];
  const add = (to, extra = {}) => {
    if (rankOf(to) === 0) {
      for (const promotion of PROMOTIONS) moves.push({ from, to, promotion, ...extra });
    } else {
      moves.push({ from, to, ...extra });
    }
  };

  const one = step(rank, file, forward, 0, crossingFiles(0));
  if (one && !state.board[sq(one.rank, one.file)]) {
    add(sq(one.rank, one.file));
    if (!piece.moved) {
      const two = sq(one.rank + forward, file);
      if (!state.board[two]) add(two, { doubleStep: sq(one.rank, one.file) });
    }
  }
  for (const target of attackedSquares(state, from)) {
    if (canCapture(state, target, piece.color)) {
      add(target);
    } else if (!state.board[target]) {
      const ep = state.enPassant.find((e) => e.square === target && e.by !== piece.color);
      if (ep) add(target, { enPassantCapture: ep.pawn });
    }
  }
  return moves;
}

function castlingMoves(state, from) {
  const king = state.board[from];
  if (king.moved || isAttacked(state, from, king.color)) return [];
  const start = SECTOR_START[king.color];
  const moves = [];
  for (const { rookFile, kingTo, rookTo, between } of [
    { rookFile: 0, kingTo: 1, rookTo: 2, between: [1, 2] },
    { rookFile: 7, kingTo: 5, rookTo: 4, between: [4, 5, 6] },
  ]) {
    const rookFrom = sq(0, start + rookFile);
    const rook = state.board[rookFrom];
    if (!rook || rook.type !== 'R' || rook.color !== king.color || rook.moved) continue;
    if (between.some((f) => state.board[sq(0, start + f)])) continue;
    // The king may not pass through or land on an attacked square.
    const dir = kingTo > KING_FILE ? 1 : -1;
    if (isAttacked(state, sq(0, start + KING_FILE + dir), king.color)) continue;
    moves.push({
      from,
      to: sq(0, start + kingTo),
      castleRook: { from: rookFrom, to: sq(0, start + rookTo) },
    });
  }
  return moves;
}

function pseudoMoves(state, from) {
  const piece = state.board[from];
  if (piece.type === 'P') return pawnMoves(state, from);
  const moves = attackedSquares(state, from)
    .filter((to) => !state.board[to] || canCapture(state, to, piece.color))
    .map((to) => ({ from, to }));
  if (piece.type === 'K') moves.push(...castlingMoves(state, from));
  return moves;
}

// Moves the pieces and nothing else.
function moveOnBoard(board, move) {
  const next = board.slice();
  const piece = { ...next[move.from], moved: true };
  // An inward pawn on rank 5 can only move by crossing the hole.
  if (piece.type === 'P' && !piece.crossed && rankOf(move.from) === RANKS - 1) {
    piece.crossed = true;
  }
  if (move.promotion) {
    piece.type = move.promotion;
    piece.crossed = false;
  }
  next[move.from] = null;
  next[move.to] = piece;
  if (move.enPassantCapture !== undefined) next[move.enPassantCapture] = null;
  if (move.castleRook) {
    next[move.castleRook.to] = { ...next[move.castleRook.from], moved: true };
    next[move.castleRook.from] = null;
  }
  return next;
}

// Both of a player's moats go for good once they are out of the game, or once none
// of their own pieces is left on their back rank.
function remainingMoats(board, moats, alive) {
  return moats.filter((moat) => !COLORS.some((color) => {
    const start = SECTOR_START[color];
    if (moat !== start && moat !== (start + 8) % FILES) return false;
    if (!alive[color]) return true;
    return [...Array(8).keys()].every((i) => board[sq(0, start + i)]?.color !== color);
  }));
}

// Legal moves for `color`, optionally only those of the piece on `from`.
export function legalMoves(state, color = state.turn, from = null) {
  if (state.status !== 'active' || !state.alive[color]) return [];
  const moves = [];
  state.board.forEach((piece, square) => {
    if (!piece || piece.color !== color) return;
    if (from !== null && square !== from) return;
    for (const move of pseudoMoves(state, square)) {
      // Taking a king turns its army to corpses, which then give no check.
      const victim = capturesLivingKing(state, move);
      const board = moveOnBoard(state.board, move);
      const alive = victim ? { ...state.alive, [victim]: false } : state.alive;
      const after = { ...state, board, alive, moats: remainingMoats(board, state.moats, alive) };
      if (!isInCheck(after, color)) moves.push(move);
    }
  });
  return moves;
}

function kill(state, color) {
  state.alive[color] = false;
  state.enPassant = state.enPassant.filter((e) => e.by !== color);
  state.moats = remainingMoats(state.board, state.moats, state.alive);
  const living = COLORS.filter((c) => state.alive[c]);
  if (living.length === 1) {
    state.status = 'won';
    state.winner = living[0];
  }
}

// Passes the turn to the next living player, burying anyone checkmated on the
// way. Mate is judged at the start of a player's turn, because the player in
// between might still have lifted the check.
function advanceTurn(state) {
  let color = state.turn;
  while (state.status === 'active') {
    color = COLORS[(COLORS.indexOf(color) + 1) % COLORS.length];
    if (!state.alive[color]) continue;
    state.turn = color;
    if (legalMoves(state, color).length > 0) return;
    // Stalemate only counts as a draw once it's down to two players.
    if (isInCheck(state, color) || COLORS.every((c) => state.alive[c])) {
      state.log.push(`${COLOR_NAMES[color]} is checkmated`);
      kill(state, color);
    } else {
      state.log.push(`${COLOR_NAMES[color]} is stalemated`);
      state.status = 'draw';
    }
  }
}

function describeMove(state, move) {
  const piece = state.board[move.from];
  if (move.castleRook) {
    return `${COLOR_NAMES[piece.color]}: ${move.to < move.from ? 'O-O' : 'O-O-O'}`;
  }
  const capture = state.board[move.to] || move.enPassantCapture !== undefined;
  const letter = piece.type === 'P' ? '' : piece.type;
  const promotion = move.promotion ? `=${move.promotion}` : '';
  const sep = capture ? 'x' : '-';
  return `${COLOR_NAMES[piece.color]}: ${letter}${squareName(move.from)}${sep}${squareName(move.to)}${promotion}`;
}

// Plays { from, to, promotion? } for the player on turn and returns the new
// state. Throws if the move is illegal; the input state is left untouched.
export function applyMove(state, { from, to, promotion }) {
  const move = legalMoves(state, state.turn, from)
    .find((m) => m.to === to && (m.promotion ?? null) === (promotion ?? null));
  if (!move) throw new Error('Illegal move');

  const next = structuredClone(state);
  next.log.push(describeMove(state, move));
  next.board = moveOnBoard(state.board, move);
  next.moats = remainingMoats(next.board, next.moats, next.alive);
  next.lastMove = { from, to };
  // En passant lasts until the pushing player's next turn, giving each opponent
  // one chance. Entries whose pawn has already been captured are dropped too.
  next.enPassant = next.enPassant.filter((e) =>
    e.by !== state.turn && next.board[e.pawn]?.color === e.by && next.board[e.pawn].type === 'P');
  if (move.doubleStep !== undefined) {
    next.enPassant.push({ square: move.doubleStep, pawn: to, by: state.turn });
  }
  const victim = capturesLivingKing(state, move);
  if (victim) {
    next.log.push(`${COLOR_NAMES[victim]}'s king is captured`);
    kill(next, victim);
  }
  advanceTurn(next);
  return next;
}

export function resign(state, color) {
  if (state.status !== 'active' || !state.alive[color]) throw new Error('Cannot resign');
  const next = structuredClone(state);
  next.log.push(`${COLOR_NAMES[color]} resigns`);
  kill(next, color);
  if (next.turn === color) advanceTurn(next);
  return next;
}
