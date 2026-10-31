import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createGame, legalMoves, applyMove, resign, isInCheck, isLightSquare, sq, rankOf, COLORS, SQUARES,
} from '../shared/engine.js';

// Builds a position from { square: 'wK' }. Pieces default to having moved so
// that castling and double steps only appear where a test asks for them.
function position(pieces, turn = 'w', alive = {}) {
  const state = createGame();
  state.board = new Array(SQUARES).fill(null);
  state.turn = turn;
  state.alive = { w: true, g: true, b: true, ...alive };
  for (const [square, code] of Object.entries(pieces)) {
    state.board[square] = {
      color: code[0], type: code[1], moved: !code.includes('*'), crossed: code.includes('^'),
    };
  }
  return state;
}

const targets = (state, from, color = state.turn) =>
  [...new Set(legalMoves(state, color, from).map((m) => m.to))].sort((a, b) => a - b);
const sorted = (...squares) => squares.sort((a, b) => a - b);

const X1 = sq(0, 23);

// Three kings tucked out of the way, for tests about something else.
const KINGS = { [sq(0, 4)]: 'wK', [sq(0, 12)]: 'gK', [sq(0, 20)]: 'bK' };

test('starting position: 16 pieces each, one third of the board, back two rows', () => {
  const state = createGame();
  assert.equal(state.board.length, 144);
  for (const [color, start] of [['w', 0], ['g', 8], ['b', 16]]) {
    const squares = state.board.flatMap((p, i) => (p?.color === color ? [i] : []));
    assert.equal(squares.length, 16);
    const expected = [];
    for (let f = start; f < start + 8; f++) expected.push(sq(0, f), sq(1, f));
    assert.deepEqual(squares, expected.sort((a, b) => a - b));
    assert.deepEqual(
      [...Array(8).keys()].map((i) => state.board[sq(0, start + i)].type).join(''),
      'RNBKQBNR',
    );
  }
});

test('white opens with only pawn and knight moves: moats stop the captures', () => {
  const moves = legalMoves(createGame());
  assert.equal(moves.length, 20);
  for (const [from, to] of [[sq(0, 0), sq(0, 23)], [sq(0, 7), sq(0, 8)], [sq(0, 1), sq(1, 23)], [sq(0, 6), sq(1, 8)]]) {
    assert.ok(!moves.some((m) => m.from === from && m.to === to));
  }
});

test('every king starts on a light square', () => {
  createGame().board.forEach((piece, square) => {
    if (piece?.type === 'K') assert.equal(isLightSquare(square), true);
  });
});

test('turns go white, gray, black', () => {
  let state = createGame();
  state = applyMove(state, { from: sq(1, 0), to: sq(2, 0) });
  assert.equal(state.turn, 'g');
  state = applyMove(state, { from: sq(1, 8), to: sq(2, 8) });
  assert.equal(state.turn, 'b');
  state = applyMove(state, { from: sq(1, 16), to: sq(2, 16) });
  assert.equal(state.turn, 'w');
});

test('moving out of turn or illegally throws and leaves state alone', () => {
  const state = createGame();
  assert.throws(() => applyMove(state, { from: sq(1, 8), to: sq(2, 8) }));
  assert.throws(() => applyMove(state, { from: sq(1, 0), to: sq(4, 0) }));
  assert.equal(state.turn, 'w');
  assert.ok(state.board[sq(1, 0)]);
});

test('rook crosses the hole to the opposite file and carries on outward', () => {
  const state = position({ ...KINGS, [sq(3, 2)]: 'wR' });
  const from = sq(3, 2);
  const radial = targets(state, from).filter((s) => [2, 14].includes(s % 24));
  assert.deepEqual(radial, sorted(
    sq(0, 2), sq(1, 2), sq(2, 2), sq(4, 2), sq(5, 2),
    sq(5, 14), sq(4, 14), sq(3, 14), sq(2, 14), sq(1, 14), sq(0, 14),
  ));
});

test('rook crossing stops at blockers on the far side and captures them', () => {
  const state = position({ ...KINGS, [sq(5, 2)]: 'wR', [sq(4, 14)]: 'gN' });
  const t = targets(state, sq(5, 2));
  assert.ok(t.includes(sq(5, 14)));
  assert.ok(t.includes(sq(4, 14)));
  assert.ok(!t.includes(sq(3, 14)));
});

test('rook slides all the way round a ring, wrapping past file x', () => {
  const state = position({ ...KINGS, [sq(3, 23)]: 'wR' });
  const ring = targets(state, sq(3, 23)).filter((s) => rankOf(s) === 3);
  assert.equal(ring.length, 23);
  assert.ok(ring.includes(sq(3, 0)));
  assert.ok(!ring.includes(sq(3, 23)));
});

test('bishop moves diagonally, wraps files, and crosses the hole', () => {
  // One outward diagonal ends on white's own king, the other on black's.
  const state = position({ ...KINGS, [sq(4, 0)]: 'wB' });
  assert.deepEqual(targets(state, sq(4, 0)), sorted(
    sq(5, 1), sq(5, 15), sq(4, 16), sq(3, 17), sq(2, 18), sq(1, 19), sq(0, 20),
    sq(5, 23), sq(5, 9), sq(4, 8), sq(3, 7), sq(2, 6), sq(1, 5),
    sq(3, 1), sq(2, 2), sq(1, 3),
    sq(3, 23), sq(2, 22), sq(1, 21),
  ));
});

test('diagonal loop: the c1 bishop runs the whole loop in either direction', () => {
  const state = position({ ...KINGS, [sq(0, 2)]: 'wB' });
  assert.deepEqual(targets(state, sq(0, 2)), sorted(
    sq(1, 3), sq(2, 4), sq(3, 5), sq(4, 6), sq(5, 7), // d2 e3 f4 g5 h6
    sq(5, 21), sq(4, 22), sq(3, 23), sq(2, 0), sq(1, 1), // v6 w5 x4 a3 b2
  ));
});

test('diagonal loop: a square reachable both ways round is one move', () => {
  const state = position({ ...KINGS, [sq(0, 2)]: 'wB' });
  const moves = legalMoves(state, 'w', sq(0, 2)).map((m) => m.to);
  assert.equal(moves.length, 10);
  assert.equal(new Set(moves).size, 10);
});

test('diagonal loop: h6 and v6 connect both ways, and pieces there block', () => {
  const state = position({ ...KINGS, [sq(5, 7)]: 'wB', [sq(4, 22)]: 'gN' });
  const t = targets(state, sq(5, 7));
  assert.ok(t.includes(sq(5, 21)), 'h6 to v6');
  assert.ok(t.includes(sq(4, 22)), 'captures on the far side');
  assert.ok(!t.includes(sq(3, 23)), 'stops at the capture');
  const back = position({ ...KINGS, [sq(5, 21)]: 'wB' });
  assert.ok(targets(back, sq(5, 21)).includes(sq(5, 7)), 'v6 to h6');
});

test('diagonal loop: a move ends on the back rank instead of boomeranging', () => {
  // b2 reaches c1, but only e3's capture stops it getting to d2 the long way.
  const state = position({ ...KINGS, [sq(1, 1)]: 'wB', [sq(2, 4)]: 'gN' });
  const t = targets(state, sq(1, 1));
  assert.ok(t.includes(sq(0, 2)), 'b2 to c1');
  assert.ok(t.includes(sq(2, 4)), 'captures e3 the long way');
  assert.ok(!t.includes(sq(1, 3)), 'no carrying on from c1 to d2');
});

test('diagonal loop: bishops stay on their square colour', () => {
  const colour = (square) => (rankOf(square) + square % 24) % 2;
  for (const start of [sq(0, 2), sq(2, 7), sq(5, 7), sq(5, 21), sq(3, 12), sq(4, 19)]) {
    const state = position({ ...KINGS, [start]: 'wB' });
    const moves = targets(state, start);
    assert.ok(moves.length > 0);
    for (const to of moves) assert.equal(colour(to), colour(start));
  }
});

test('diagonal loop: gives check through the hole', () => {
  const state = position({ [sq(4, 22)]: 'wK', [sq(4, 6)]: 'gB', [sq(0, 12)]: 'gK', [sq(0, 20)]: 'bK' });
  assert.equal(isInCheck(state, 'w'), true);
  state.board[sq(5, 21)] = { color: 'b', type: 'N', moved: true, crossed: false };
  assert.equal(isInCheck(state, 'w'), false, 'blocked on v6');
});

test('diagonal loop: moats stop the long way to a corner square', () => {
  const reach = (from, to, moats) => {
    const state = position({ ...KINGS, [from]: 'wB', [to]: 'bN' });
    if (moats) state.moats = moats;
    return targets(state, from).includes(to);
  };
  assert.equal(reach(sq(3, 2), X1), false, 'c4 takes x1, either way round');
  assert.equal(reach(sq(4, 3), X1), false, 'd5 takes x1');
  assert.equal(reach(sq(5, 4), X1), false, 'e6 takes x1');
  assert.equal(reach(sq(5, 18), X1), true, 's6 takes x1 without using the hole');
  assert.equal(reach(sq(1, 22), X1), true, 'w2 takes x1');
  assert.equal(reach(sq(3, 2), X1, [8, 16]), true, 'no moat, no problem');
});

test('diagonal loop: a corner piece cannot use the long way out either', () => {
  const state = position({ ...KINGS, [X1]: 'wB' });
  const t = targets(state, X1);
  assert.ok(t.includes(sq(1, 22)), 'x1 to w2');
  assert.ok(t.includes(sq(5, 18)), 'x1 to s6');
  assert.ok(!t.includes(sq(5, 4)), 'x1 to e6');
  assert.ok(!t.includes(sq(3, 2)), 'x1 to c4');
  assert.ok(!t.includes(sq(1, 0)), 'x1 to a2');
});

test('queen combines rook and bishop, crossing on both', () => {
  // Own knights stop the queen reaching those squares the long way round the ring.
  const state = position({ ...KINGS, [sq(5, 2)]: 'wQ', [sq(5, 1)]: 'wN', [sq(5, 3)]: 'wN' });
  const t = targets(state, sq(5, 2));
  assert.ok(t.includes(sq(5, 14)), 'straight across');
  assert.ok(t.includes(sq(0, 14)), 'all the way across');
  assert.ok(t.includes(sq(4, 3)), 'diagonal');
  assert.ok(t.includes(sq(5, 16)), 'diagonal across');
  assert.ok(t.includes(sq(5, 12)), 'diagonal across');
  assert.ok(!t.includes(sq(5, 15)), 'not next to the crossing');
  assert.ok(!t.includes(sq(5, 13)), 'not next to the crossing');
});

test('knight jumps in an L and wraps files', () => {
  const state = position({ ...KINGS, [sq(3, 23)]: 'wN' });
  assert.deepEqual(targets(state, sq(3, 23)), sorted(
    sq(1, 0), sq(1, 22), sq(2, 1), sq(2, 21), sq(4, 1), sq(4, 21), sq(5, 0), sq(5, 22),
  ));
});

test('knight crosses the hole straight over, then sideways', () => {
  const near = position({ ...KINGS, [sq(4, 3)]: 'wN' });
  const t = targets(near, sq(4, 3));
  assert.ok(t.includes(sq(5, 14)), 'd5 to o6');
  assert.ok(t.includes(sq(5, 16)), 'd5 to q6');
  assert.ok(!t.includes(sq(5, 17)), 'not along the bishop loop');
  const edge = position({ ...KINGS, [sq(5, 3)]: 'wN' });
  assert.deepEqual(targets(edge, sq(5, 3)), sorted(
    sq(4, 1), sq(4, 5), sq(3, 2), sq(3, 4), // this side
    sq(5, 13), sq(5, 17), sq(4, 14), sq(4, 16), // far side
  ));
});

test('king moves one square any way, including across the hole', () => {
  const state = position({ [sq(5, 2)]: 'wK', [sq(0, 12)]: 'gK', [sq(0, 20)]: 'bK' });
  assert.deepEqual(targets(state, sq(5, 2)), sorted(
    sq(5, 1), sq(5, 3), sq(4, 1), sq(4, 2), sq(4, 3),
    sq(5, 14), sq(5, 16), sq(5, 12), // straight over, then the two diagonals
  ));
});

test('pawn: double step from the start only, blocked pawns stay put', () => {
  const state = createGame();
  assert.deepEqual(targets(state, sq(1, 3)), sorted(sq(2, 3), sq(3, 3)));
  const later = position({ ...KINGS, [sq(2, 3)]: 'wP' });
  assert.deepEqual(targets(later, sq(2, 3)), [sq(3, 3)]);
  const blocked = position({ ...KINGS, [sq(1, 3)]: 'wP*', [sq(2, 3)]: 'gN' });
  assert.deepEqual(targets(blocked, sq(1, 3)), []);
  const halfBlocked = position({ ...KINGS, [sq(1, 3)]: 'wP*', [sq(3, 3)]: 'gN' });
  assert.deepEqual(targets(halfBlocked, sq(1, 3)), [sq(2, 3)]);
});

test('pawn crosses the hole, then heads outward', () => {
  let state = position({ ...KINGS, [sq(5, 3)]: 'wP' });
  assert.deepEqual(targets(state, sq(5, 3)), [sq(5, 15)]);
  state = applyMove(state, { from: sq(5, 3), to: sq(5, 15) });
  assert.equal(state.board[sq(5, 15)].crossed, true);
  state.turn = 'w';
  assert.deepEqual(targets(state, sq(5, 15)), [sq(4, 15)]);
});

test('pawn on the inner rank captures along the diagonal loop', () => {
  const state = position({
    ...KINGS, [sq(5, 3)]: 'wP', [sq(5, 17)]: 'bN', [sq(5, 13)]: 'gN', [sq(5, 4)]: 'gN',
    [sq(5, 14)]: 'gN', [sq(5, 16)]: 'bN',
  });
  assert.deepEqual(targets(state, sq(5, 3)), sorted(sq(5, 13), sq(5, 15), sq(5, 17)));
  const after = applyMove(state, { from: sq(5, 3), to: sq(5, 17) });
  assert.equal(after.board[sq(5, 17)].crossed, true, 'then heads outward');
});

test('pawn captures forward diagonals only, never straight or its own', () => {
  const state = position({
    ...KINGS, [sq(2, 3)]: 'wP', [sq(3, 3)]: 'gN', [sq(3, 4)]: 'gN', [sq(3, 2)]: 'wN', [sq(1, 4)]: 'gN',
  });
  assert.deepEqual(targets(state, sq(2, 3)), [sq(3, 4)]);
});

test('pawn promotes only on the far outer rank, to the chosen piece', () => {
  const state = position({ ...KINGS, [sq(1, 15)]: 'wP^' });
  const moves = legalMoves(state, 'w', sq(1, 15)).filter((m) => m.to === sq(0, 15));
  assert.deepEqual(moves.map((m) => m.promotion).sort(), ['B', 'N', 'Q', 'R']);
  assert.throws(() => applyMove(state, { from: sq(1, 15), to: sq(0, 15) }));
  const after = applyMove(state, { from: sq(1, 15), to: sq(0, 15), promotion: 'N' });
  assert.equal(after.board[sq(0, 15)].type, 'N');
});

test('castling both ways moves king and rook', () => {
  const pieces = {
    [sq(0, 0)]: 'wR*', [sq(0, 3)]: 'wK*', [sq(0, 7)]: 'wR*',
    [sq(0, 12)]: 'gK', [sq(0, 20)]: 'bK',
  };
  const short = applyMove(position(pieces), { from: sq(0, 3), to: sq(0, 1) });
  assert.equal(short.board[sq(0, 1)].type, 'K');
  assert.equal(short.board[sq(0, 2)].type, 'R');
  assert.equal(short.board[sq(0, 0)], null);
  assert.match(short.log.at(-1), /O-O$/);
  const long = applyMove(position(pieces), { from: sq(0, 3), to: sq(0, 5) });
  assert.equal(long.board[sq(0, 5)].type, 'K');
  assert.equal(long.board[sq(0, 4)].type, 'R');
  assert.equal(long.board[sq(0, 7)], null);
  assert.match(long.log.at(-1), /O-O-O$/);
});

test('castling works from the real starting squares of every colour', () => {
  const state = createGame();
  for (const [color, start] of [['w', 0], ['g', 8], ['b', 16]]) {
    for (const f of [1, 2, 4, 5, 6]) state.board[sq(0, start + f)] = null;
    assert.deepEqual(
      targets({ ...state, turn: color }, sq(0, start + 3)).filter((s) => rankOf(s) === 0),
      sorted(sq(0, start + 1), sq(0, start + 2), sq(0, start + 4), sq(0, start + 5)),
    );
  }
});

test('no castling after moving, when blocked, in check, or through attack', () => {
  const base = {
    [sq(0, 3)]: 'wK*', [sq(0, 0)]: 'wR*', [sq(0, 12)]: 'gK', [sq(0, 20)]: 'bK',
  };
  const can = (extra) => targets(position({ ...base, ...extra }), sq(0, 3)).includes(sq(0, 1));
  assert.equal(can({}), true);
  assert.equal(can({ [sq(0, 3)]: 'wK' }), false, 'king moved');
  assert.equal(can({ [sq(0, 0)]: 'wR' }), false, 'rook moved');
  assert.equal(can({ [sq(0, 2)]: 'bN' }), false, 'blocked');
  assert.equal(can({ [sq(3, 3)]: 'gR' }), false, 'in check');
  assert.equal(can({ [sq(3, 2)]: 'bR' }), false, 'through attack');
  assert.equal(can({ [sq(3, 1)]: 'gR' }), false, 'into attack');
  assert.equal(can({ [sq(3, 0)]: 'gR' }), true, 'rook itself may be attacked');
});

test('a corpse blocks castling but does not stop it by attacking', () => {
  const base = {
    [sq(0, 3)]: 'wK*', [sq(0, 0)]: 'wR*', [sq(0, 12)]: 'gK', [sq(0, 20)]: 'bK',
  };
  const dead = { b: false };
  const attacking = position({ ...base, [sq(3, 2)]: 'bR' }, 'w', dead);
  assert.ok(targets(attacking, sq(0, 3)).includes(sq(0, 1)));
  const blocking = position({ ...base, [sq(0, 2)]: 'bN' }, 'w', dead);
  assert.ok(!targets(blocking, sq(0, 3)).includes(sq(0, 1)));
});

test('en passant: available to the next opponent and removes the pawn', () => {
  let state = position({ ...KINGS, [sq(1, 8)]: 'gP*', [sq(3, 9)]: 'wP^' }, 'g');
  state = applyMove(state, { from: sq(1, 8), to: sq(3, 8) });
  state = applyMove(state, { from: sq(0, 20), to: sq(0, 21) }); // black passes on it
  const after = applyMove(state, { from: sq(3, 9), to: sq(2, 8) });
  assert.equal(after.board[sq(3, 8)], null);
  assert.equal(after.board[sq(2, 8)].color, 'w');
  assert.match(after.log.at(-1), /x/);
});

test('en passant: each opponent gets a chance, then it expires', () => {
  const pieces = { ...KINGS, [sq(1, 10)]: 'gP*', [sq(3, 11)]: 'bP^', [sq(3, 9)]: 'wP^' };
  let state = position(pieces, 'g');
  state = applyMove(state, { from: sq(1, 10), to: sq(3, 10) });
  assert.ok(targets(state, sq(3, 11)).includes(sq(2, 10)), 'black can take');
  state = applyMove(state, { from: sq(0, 20), to: sq(0, 21) });
  assert.ok(targets(state, sq(3, 9)).includes(sq(2, 10)), 'white can still take');
  state = applyMove(state, { from: sq(0, 4), to: sq(0, 3) });
  state = applyMove(state, { from: sq(0, 12), to: sq(0, 11) }); // gray's turn ends the right
  assert.ok(!targets(state, sq(3, 11)).includes(sq(2, 10)), 'expired for black');
});

test('en passant is gone once the pawn has been captured', () => {
  const pieces = {
    ...KINGS, [sq(1, 8)]: 'gP*', [sq(3, 9)]: 'wP^', [sq(5, 8)]: 'bR',
  };
  let state = position(pieces, 'g');
  state = applyMove(state, { from: sq(1, 8), to: sq(3, 8) });
  state = applyMove(state, { from: sq(5, 8), to: sq(3, 8) }); // black takes it normally
  assert.ok(!targets(state, sq(3, 9)).includes(sq(2, 8)));
});

test('a king is in check from either opponent', () => {
  assert.equal(isInCheck(position({ ...KINGS, [sq(3, 4)]: 'gR' }), 'w'), true);
  assert.equal(isInCheck(position({ ...KINGS, [sq(3, 4)]: 'bR' }), 'w'), true);
  assert.equal(isInCheck(position({ ...KINGS, [sq(3, 4)]: 'wR' }), 'w'), false);
});

test('rook attacks a king across the hole', () => {
  const state = position({ [sq(0, 16)]: 'wK', [sq(0, 12)]: 'gK', [sq(0, 20)]: 'bK', [sq(2, 4)]: 'gR' });
  assert.equal(isInCheck(state, 'w'), true);
});

test('pawn attacks a king across the hole', () => {
  const state = position({ [sq(5, 17)]: 'wK', [sq(0, 12)]: 'gK', [sq(0, 20)]: 'bK', [sq(5, 3)]: 'bP' });
  assert.equal(isInCheck(state, 'w'), true);
});

test('a move leaving your own king attacked is illegal, including pins', () => {
  const state = position({
    [sq(0, 4)]: 'wK', [sq(2, 4)]: 'wR', [sq(4, 4)]: 'gR', [sq(0, 12)]: 'gK', [sq(0, 20)]: 'bK',
  });
  const moves = targets(state, sq(2, 4));
  assert.deepEqual(moves, sorted(sq(1, 4), sq(3, 4), sq(4, 4)));
});

function mateNet() {
  // Gray rook checks along file a; black rooks seal ranks 1 and 2.
  return position({
    [sq(0, 0)]: 'wK',
    [sq(0, 8)]: 'gK',
    [sq(5, 20)]: 'bK',
    [sq(4, 0)]: 'gR',
    [sq(4, 1)]: 'bR',
    [sq(3, 23)]: 'bR',
  }, 'b');
}

test('checkmate by two players together turns the victim into a corpse', () => {
  let state = mateNet();
  // Black's quiet move hands the turn to white, who has no way out.
  state = applyMove(state, { from: sq(5, 20), to: sq(5, 21) });
  assert.equal(state.alive.w, false);
  assert.equal(state.turn, 'g', 'white is skipped');
  assert.ok(state.log.includes('White is checkmated'));
  assert.equal(state.board[sq(0, 0)].color, 'w', 'corpse stays on the board');
  assert.equal(state.status, 'active');
});

test('mate is judged on the victim\'s turn: the player between can lift it', () => {
  let state = position({
    [sq(0, 0)]: 'wK',
    [sq(0, 8)]: 'gK',
    [sq(5, 20)]: 'bK',
    [sq(4, 0)]: 'gR',
    [sq(4, 1)]: 'bR',
    [sq(3, 23)]: 'bR',
  }, 'g');
  // Black's rooks seal the king in, but it is gray's move and gray's own rook
  // gives the check. Gray steps away, so white is no longer mated on black's move.
  state = applyMove(state, { from: sq(4, 0), to: sq(4, 22) });
  assert.equal(state.alive.w, true);
  state = applyMove(state, { from: sq(5, 20), to: sq(5, 21) });
  assert.equal(state.alive.w, true);
  assert.equal(state.turn, 'w');
});

test('corpses: no attacks, no turns, block movement, can be captured', () => {
  const dead = { b: false };
  const state = position({
    [sq(0, 4)]: 'wK', [sq(3, 4)]: 'bR', [sq(3, 10)]: 'wR', [sq(3, 8)]: 'bN',
    [sq(0, 12)]: 'gK', [sq(0, 20)]: 'bK',
  }, 'w', dead);
  assert.equal(isInCheck(state, 'w'), false, 'corpse rook gives no check');
  const t = targets(state, sq(3, 10));
  assert.ok(t.includes(sq(3, 8)), 'can capture corpse');
  assert.ok(!t.includes(sq(3, 7)), 'corpse blocks');
  const after = applyMove(state, { from: sq(0, 4), to: sq(0, 3) });
  assert.equal(after.turn, 'g');
  const next = applyMove(after, { from: sq(0, 12), to: sq(0, 11) });
  assert.equal(next.turn, 'w', 'black is skipped');
});

test('a corpse king can be captured', () => {
  const dead = position({ [sq(0, 4)]: 'wK', [sq(3, 20)]: 'wR', [sq(0, 12)]: 'gK', [sq(0, 20)]: 'bK' }, 'w', { b: false });
  assert.ok(targets(dead, sq(3, 20)).includes(sq(0, 20)));
});

// White's knight stands between gray's rook and black's king.
const EXPOSED = {
  [sq(0, 4)]: 'wK', [sq(3, 12)]: 'wN', [sq(5, 12)]: 'gR',
  [sq(0, 14)]: 'gK', [sq(0, 12)]: 'bK',
};

test('a king exposed by another player\'s move can be captured', () => {
  let state = position(EXPOSED);
  state = applyMove(state, { from: sq(3, 12), to: sq(1, 13) });
  assert.equal(state.turn, 'g');
  state = applyMove(state, { from: sq(5, 12), to: sq(0, 12) });
  assert.equal(state.alive.b, false, 'black is out');
  assert.equal(state.board[sq(0, 12)].color, 'g');
  assert.ok(state.log.includes("Black's king is captured"));
  assert.equal(state.turn, 'w', 'black is skipped');
  assert.equal(state.status, 'active');
});

test('an exposed king\'s owner can still escape if the attacker declines', () => {
  let state = position(EXPOSED);
  state = applyMove(state, { from: sq(3, 12), to: sq(1, 13) });
  state = applyMove(state, { from: sq(0, 14), to: sq(1, 14) });
  assert.equal(state.turn, 'b');
  assert.equal(isInCheck(state, 'b'), true);
  assert.ok(legalMoves(state).length > 0);
});

test('capturing the king that gives check is legal, since its army dies', () => {
  // Black's rook checks gray; gray's king-capture removes that check.
  const state = position({
    [sq(0, 4)]: 'wK', [sq(0, 14)]: 'gK', [sq(3, 14)]: 'bR', [sq(5, 2)]: 'gR', [sq(0, 2)]: 'bK',
  }, 'g');
  assert.equal(isInCheck(state, 'g'), true);
  const after = applyMove(state, { from: sq(5, 2), to: sq(0, 2) });
  assert.equal(after.alive.b, false);
  assert.equal(isInCheck(after, 'g'), false);
});

test('last player standing wins', () => {
  let state = position(KINGS);
  state = resign(state, 'g');
  assert.equal(state.status, 'active');
  assert.equal(state.turn, 'w', 'resigning off-turn does not move the turn');
  state = resign(state, 'w');
  assert.equal(state.status, 'won');
  assert.equal(state.winner, 'b');
  assert.deepEqual(legalMoves(state), []);
});

test('resigning on your turn passes it on', () => {
  const state = resign(position(KINGS), 'w');
  assert.equal(state.turn, 'g');
  assert.equal(state.alive.w, false);
});

// Gray's rooks cover everything round white's king without checking it.
const STALEMATE = {
  [sq(0, 0)]: 'wK',
  [sq(1, 5)]: 'gR',
  [sq(2, 1)]: 'gR',
  [sq(2, 23)]: 'gR',
  [sq(0, 12)]: 'gK',
  [sq(5, 20)]: 'bK',
};

test('stalemate with three players left counts as checkmate', () => {
  const state = applyMove(position(STALEMATE, 'b'), { from: sq(5, 20), to: sq(5, 21) });
  assert.equal(state.status, 'active');
  assert.equal(state.alive.w, false);
  assert.equal(state.turn, 'g');
  assert.equal(state.board[sq(0, 0)].color, 'w', 'corpse stays on the board');
  assert.ok(state.log.includes('White is checkmated'));
  assert.ok(!state.moats.includes(0), 'its moats go');
});

test('stalemate with two players left is a draw', () => {
  const state = applyMove(position(STALEMATE, 'g', { b: false }), { from: sq(0, 12), to: sq(0, 11) });
  assert.equal(state.status, 'draw');
  assert.equal(state.winner, null);
  assert.equal(state.alive.w, true);
});

test('moat: the bishop and knight examples from the rules', () => {
  const bishop = position({ ...KINGS, [sq(3, 2)]: 'wB', [X1]: 'bR' });
  assert.ok(!targets(bishop, sq(3, 2)).includes(X1), 'c4 bishop cannot take x1');
  assert.ok(targets(bishop, sq(3, 2)).includes(sq(1, 0)), 'but reaches a2');
  const knight = position({ ...KINGS, [sq(2, 0)]: 'wN', [X1]: 'bR' });
  assert.ok(!targets(knight, sq(2, 0)).includes(X1), 'a3 knight cannot take x1');
});

test('moat: covers the back rank only, for every kind of piece', () => {
  const rook = position({ ...KINGS, [sq(0, 0)]: 'wR', [sq(1, 2)]: 'wR' });
  assert.ok(!targets(rook, sq(0, 0)).includes(X1), 'back rank sideways');
  assert.ok(targets(rook, sq(1, 2)).includes(sq(1, 23)), 'second rank is free');
  const bishop = position({ ...KINGS, [sq(0, 0)]: 'wB', [sq(1, 0)]: 'wB' });
  assert.ok(!targets(bishop, sq(0, 0)).includes(sq(1, 23)), 'a1 to x2 clips the corner');
  assert.ok(!targets(bishop, sq(1, 0)).includes(X1), 'a2 to x1 clips the corner');
  assert.ok(targets(bishop, sq(1, 0)).includes(sq(2, 23)), 'a2 to x3 misses it');
  const king = position({ [sq(0, 0)]: 'wK', [sq(0, 12)]: 'gK', [sq(0, 20)]: 'bK' });
  assert.deepEqual(targets(king, sq(0, 0)), sorted(sq(0, 1), sq(1, 0), sq(1, 1)));
  const knight = position({ ...KINGS, [sq(0, 1)]: 'wN', [sq(1, 0)]: 'wN', [sq(1, 1)]: 'wN' });
  assert.ok(!targets(knight, sq(0, 1)).includes(sq(1, 23)), 'b1 to x2');
  assert.ok(!targets(knight, sq(1, 0)).includes(sq(0, 22)), 'a2 to w1');
  assert.ok(targets(knight, sq(1, 0)).includes(sq(3, 23)), 'a2 to x4 is clear of it');
  assert.ok(targets(knight, sq(1, 1)).includes(sq(2, 23)), 'b2 to x3 is clear of it');
  const pawn = position({ ...KINGS, [sq(1, 0)]: 'wP^', [X1]: 'bN' });
  assert.deepEqual(targets(pawn, sq(1, 0)), [sq(0, 0)]);
});

test('moat: applies at all three borders, from both sides', () => {
  const state = position({ ...KINGS, [sq(0, 7)]: 'wR', [sq(0, 8)]: 'gR', [sq(0, 15)]: 'gR', [sq(0, 16)]: 'bR' }, 'g');
  assert.ok(!targets(state, sq(0, 8)).includes(sq(0, 7)));
  assert.ok(!targets(state, sq(0, 15)).includes(sq(0, 16)));
});

test('moat: blocks check', () => {
  const pieces = { [sq(0, 0)]: 'wK', [sq(0, 12)]: 'gK', [sq(0, 20)]: 'bK', [X1]: 'bR' };
  assert.equal(isInCheck(position(pieces), 'w'), false);
  const gone = position(pieces);
  gone.moats = [8, 16];
  assert.equal(isInCheck(gone, 'w'), true);
});

// White's rook is the last white piece on the back rank.
function lastRookOnRank(extra = {}) {
  return position({
    [sq(0, 3)]: 'wR', [sq(3, 4)]: 'wK',
    [sq(0, 12)]: 'gK', [sq(0, 20)]: 'bK', ...extra,
  });
}

test('moat: clearing a back rank removes both of that player\'s moats for good', () => {
  let state = applyMove(lastRookOnRank(), { from: sq(0, 3), to: sq(1, 3) });
  assert.deepEqual(state.moats, [16]);
  state = applyMove(state, { from: sq(0, 12), to: sq(0, 13) });
  state = applyMove(state, { from: sq(0, 20), to: sq(0, 21) });
  state = applyMove(state, { from: sq(1, 3), to: sq(0, 3) });
  assert.deepEqual(state.moats, [16], 'moving back does not restore them');
});

test('moat: pieces moving along the rank do not clear it', () => {
  const state = applyMove(lastRookOnRank(), { from: sq(0, 3), to: sq(0, 2) });
  assert.deepEqual(state.moats, [0, 8, 16]);
});

test('moat: the shared moat goes when either neighbour clears their rank', () => {
  const state = applyMove(lastRookOnRank(), { from: sq(0, 3), to: sq(1, 3) });
  // The gray-white border is gone though gray's rank is occupied; gray-black stays.
  assert.ok(!state.moats.includes(8));
  assert.ok(state.moats.includes(16));
});

test('moat: an enemy piece on the rank does not keep it up', () => {
  const state = applyMove(lastRookOnRank({ [sq(0, 5)]: 'gN' }), { from: sq(0, 3), to: sq(1, 3) });
  assert.deepEqual(state.moats, [16]);
});

test('moat: a player who resigns loses both moats, corpses or not', () => {
  const state = resign(lastRookOnRank(), 'w');
  assert.equal(state.board[sq(0, 3)].color, 'w', 'still on the rank');
  assert.deepEqual(state.moats, [16]);
});

test('moat: a checkmated player loses both moats', () => {
  const state = applyMove(mateNet(), { from: sq(5, 20), to: sq(5, 21) });
  assert.equal(state.alive.w, false);
  assert.ok(!state.moats.includes(0));
  assert.ok(!state.moats.includes(8));
});

test('moat: a player whose king is captured loses both moats', () => {
  let state = position({ ...EXPOSED, [sq(0, 20)]: 'bN' });
  state = applyMove(state, { from: sq(3, 12), to: sq(1, 13) });
  assert.ok(state.moats.includes(0), 'black is still in');
  state = applyMove(state, { from: sq(5, 12), to: sq(0, 12) });
  assert.equal(state.alive.b, false);
  assert.deepEqual(state.moats, [8]);
});

test('moat: you cannot clear your rank if losing the moat puts you in check', () => {
  const state = position({
    [sq(0, 3)]: 'wR', [sq(1, 0)]: 'wK', [X1]: 'bB',
    [sq(0, 12)]: 'gK', [sq(0, 20)]: 'bK',
  });
  assert.equal(isInCheck(state, 'w'), false);
  const moves = targets(state, sq(0, 3));
  assert.ok(!moves.includes(sq(1, 3)), 'leaving the rank would expose the king');
  assert.ok(moves.includes(sq(0, 4)), 'staying on it is fine');
});

test('thin line: stops pawns heading inward, not those coming back out', () => {
  const canTake = (from, to, code) => targets(position({ ...KINGS, [from]: code, [to]: 'bN' }), from).includes(to);
  assert.equal(canTake(sq(1, 0), sq(2, 23), 'wP'), false, 'a2 takes x3');
  assert.equal(canTake(sq(2, 0), sq(3, 23), 'wP'), false, 'a3 takes x4 touches the end');
  assert.equal(canTake(sq(3, 0), sq(4, 23), 'wP'), true, 'a4 takes x5 is past it');
  assert.equal(canTake(sq(2, 0), sq(1, 23), 'wP^'), true, 'outward a3 takes x2');
  assert.equal(canTake(sq(3, 0), sq(2, 23), 'wP^'), true, 'outward a4 takes x3');
  assert.equal(canTake(sq(4, 0), sq(3, 23), 'wP^'), true, 'outward a5 takes x4 is past it');
  assert.equal(canTake(sq(1, 7), sq(2, 8), 'wP'), false, 'at the h-i border too');
  assert.equal(canTake(sq(1, 1), sq(2, 2), 'wP'), true, 'away from the border');
});

test('thin line: other pieces ignore it', () => {
  const state = position({ ...KINGS, [sq(1, 2)]: 'wR', [sq(2, 0)]: 'wB', [sq(1, 1)]: 'wN' });
  assert.ok(targets(state, sq(1, 2)).includes(sq(1, 23)), 'rook');
  assert.ok(targets(state, sq(2, 0)).includes(sq(1, 23)), 'bishop');
  assert.ok(targets(state, sq(1, 1)).includes(sq(2, 23)), 'knight');
});

test('thin line: only an inward pawn is stopped from giving check across it', () => {
  const kings = { [sq(0, 12)]: 'gK', [sq(0, 20)]: 'bK' };
  assert.equal(isInCheck(position({ ...kings, [sq(2, 23)]: 'wK', [sq(1, 0)]: 'gP' }), 'w'), false);
  assert.equal(isInCheck(position({ ...kings, [sq(1, 23)]: 'wK', [sq(2, 0)]: 'gP^' }), 'w'), true);
});

test('thick moat still stops an outward pawn', () => {
  const state = position({ ...KINGS, [sq(1, 0)]: 'wP^', [X1]: 'bN' });
  assert.ok(!targets(state, sq(1, 0)).includes(X1));
});

test('thin line: en passant across it works for a pawn coming back out', () => {
  let state = position({ ...KINGS, [sq(1, 8)]: 'gP*', [sq(3, 7)]: 'wP^' }, 'g');
  state = applyMove(state, { from: sq(1, 8), to: sq(3, 8) });
  state = applyMove(state, { from: sq(0, 20), to: sq(0, 21) });
  const after = applyMove(state, { from: sq(3, 7), to: sq(2, 8) });
  assert.equal(after.board[sq(3, 8)], null, 'pawn removed');
});

test('thin line: goes when its moat goes', () => {
  const state = position({ ...KINGS, [sq(1, 0)]: 'wP', [sq(2, 23)]: 'bN' });
  state.moats = [8, 16];
  assert.ok(targets(state, sq(1, 0)).includes(sq(2, 23)));
});

test('random playouts never break the invariants', () => {
  let seed = 12345;
  const random = (n) => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return Math.floor((seed / 4294967296) * n);
  };
  const finishes = { won: 0, draw: 0, active: 0 };
  for (let game = 0; game < 15; game++) {
    let state = createGame();
    let previous = null;
    for (let ply = 0; ply < 250 && state.status === 'active'; ply++) {
      const moves = legalMoves(state);
      assert.ok(moves.length > 0, 'active player always has a move');
      assert.ok(state.alive[state.turn], 'player on turn is alive');
      const move = moves[random(moves.length)];
      const mover = state.turn;
      const taken = state.board[move.to];
      if (taken?.type === 'K' && state.alive[taken.color] && previous) {
        // The only way here: the player who just moved is neither side of the
        // capture, and the king was not attacked by this mover beforehand.
        assert.notEqual(previous.turn, taken.color);
        assert.notEqual(previous.turn, mover);
        const twoSided = { w: false, g: false, b: false, [mover]: true, [taken.color]: true };
        assert.equal(isInCheck({ ...previous, alive: twoSided }, taken.color), false);
      }
      previous = state;
      state = applyMove(state, move);
      assert.equal(isInCheck(state, mover) && state.alive[mover], false, 'mover not left in check');
      for (const color of COLORS) {
        assert.equal(state.board.filter((p) => p?.color === color && p.type === 'K').length <= 1, true);
        if (state.alive[color]) {
          assert.equal(state.board.filter((p) => p?.color === color && p.type === 'K').length, 1, 'living king stays');
        }
      }
      assert.ok(JSON.parse(JSON.stringify(state)), 'state stays JSON');
    }
    finishes[state.status]++;
  }
  assert.equal(finishes.won + finishes.draw + finishes.active, 15);
});
