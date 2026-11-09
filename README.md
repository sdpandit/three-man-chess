# Three-Player Chess

Online three-player chess on a round board: 6 ranks, 24 files, 144 squares, and a
hole in the middle. One person creates a game and sends the link to the other two.
Everyone picks a colour, and the creator starts the game once all three seats are taken.
Closing the tab is fine: the same browser gets its seat back from the link.

## Run it

Needs Node 20 or newer.

```
npm install
npm start
```

Then open http://localhost:3000. Run the tests with `npm test`.

To try it alone, open http://localhost:3000/?solo to play all three colours from one window. Solo games aren't saved.

A copy of the analysis board, without online play, is at https://sdpandit.github.io/three-man-chess/.

Move pieces by dragging them or by clicking the piece and then its destination. A piece
dropped on an illegal square goes back where it started.

During a game, click any move in the history or use the left and right arrow keys to
look at past positions. Moves can only be made from the latest position. On the analysis
board, undo takes back the last action. Online, it asks to take back your last move: you
can ask once, until the next move is made, and it only happens if every other player
still in the game agrees, counting anyone the move knocked out. Clocks go back to where
they stood when the move was made. A request that isn't fully answered within 15 seconds
is declined, and if the player on move agrees, their clock waits while the others decide.

Whoever creates an online game can give it a clock from the waiting room, until the game
starts: minutes each, plus seconds added after every move. A player's clock only runs on
their turn, and not during their first move, which earns no increment. Running out of time knocks you out like
resigning. Clocks pause while the server is down.

Online games also have a chat. Players can write in it, and anyone with the game link can read it.
Players can rename themselves at any time with the ✎ next to their name, and their past
messages take the new name.

Whoever runs the server can post in a game's chat under any name:
`npm run say -- <room> <name> "<message>" [w|g|b]`. The colour is optional. This uses a
secret token the server creates in `data/admin-token`, so people with the game link can't
do the same.

## Put it online

Friends in other cities need a public address. Either of these works:

- **Host it** on any service that runs Node and allows WebSockets (Render, Railway,
  Fly.io, a VPS). The build command is `npm install`, the start command is `npm start`,
  and the port comes from the `PORT` environment variable.
- **Run it from your own computer** for an evening with a temporary tunnel, using
  `npx cloudflared tunnel --url http://localhost:3000`, and share the address it prints.
  It stops working when your computer sleeps or the command is closed.

Games are saved to `data/games.json`, or wherever `DATA_FILE` points, and reload when
the server restarts. Many free hosting tiers wipe their disk on restart, so games in
progress only survive there if `DATA_FILE` is on a persistent disk.

## Rules decisions

The spec leaves these open. Most are in `shared/engine.js`.

| Situation | Decision |
| --- | --- |
| Crossing the hole | Everything can cross. Straight moves go to the opposite file. Diagonal moves by bishops, queens, pawns, and kings land 14 files on, forming a closed loop such as c1 d2 e3 f4 g5 h6 v6 w5 x4 a3 b2. Knights cross straight over and then step sideways, so d5 can jump to o6 or q6. Reaching the back rank ends a move, and a piece can't return to its start. |
| Diagonals and moats | A back-rank square next to a moat can't be reached, or left, through the hole if the direct way along that loop crosses the moat. So c4 can't take x1 either way round, while w2 and s6 can. |
| Pawn on the inner rank | Moves straight across to the opposite file, or captures along the diagonal loop. It then heads outward. |
| Back row | R N B K Q B N R, with king and queen swapped from normal chess so that every king starts on a light square. |
| Promotion | On reaching the outer rank on the far side. |
| En passant | Each opponent gets one chance, on their next turn. The right ends when the pawn's owner moves again. |
| Capturing a living king | Only when another player's move exposes it. That player's pieces become corpses. |
| When mate is judged | At the start of the victim's turn, since the player in between can still lift the check. |
| Stalemate | With three players left, it counts as checkmate. With two left, the game is a draw. |
| Moats | Green lines between the neighbouring rooks, on the back rank only. No move, capture, or check may cross or touch one. Both of a player's moats go for good once that player is out of the game, or once none of their own pieces is on their back rank at the same moment. |
| Thin green lines | Extend each moat through the next two ranks and go when it goes. Pawns heading toward the center can't capture across or touching one, which also stops their checks. Pawns that have crossed the hole ignore them, as do all other pieces. |
| Corpses | Can't give check and block movement. Anyone can capture them, including the king. |
| Resigning | Added so a game can't hang on an absent player. The resigner's pieces become corpses. |

## Layout

- `shared/engine.js`: the rules, used by both the server and the browser
- `server/index.js`: serves the page, runs game rooms, and validates every move
- `client/`: the browser interface
- `test/`: engine and server tests
