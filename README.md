# Battleships — Team Wars

A real-time, team-based multiplayer Battleships game for roughly 15–30 people. Two teams, **Blue** and **Red**, each control one shared fleet. Every ship placement and every attack is decided by strict majority vote inside the team. A Game Master (GM) runs the game from a separate, password-protected dashboard.

- Node.js + Express + Socket.IO on the server, plain HTML/CSS/JavaScript in the browser.
- All game rules are enforced on the server. Clients only send votes and chat; they never calculate game state.
- Game state lives in memory. Restarting the server starts a fresh session.

## Run it locally

Requires Node.js 20 or newer.

```bash
npm install
HOST_KEY=choose-a-secret npm start
```

- Players: <http://localhost:3000/>
- Game Master: <http://localhost:3000/host.html> (sign in with your `HOST_KEY`)

`npm run dev` starts the server with `--watch` and a throwaway key (`dev-host-key`) for local development only.

| Variable | Purpose |
|---|---|
| `PORT` | Port to listen on (default `3000`; Render sets it automatically). |
| `HOST_KEY` | Secret the GM signs in with. If it is unset, the GM dashboard is disabled. It is never sent to players. |

## How a game runs

1. **Lobby.** Players open the site and enter a display name (max 24 characters, unique per game). The server assigns them to the smaller team. A private session token is kept in the browser, so refreshing or reconnecting puts the player back on the same team.
2. **Start.** The GM presses *Start game* once both teams have at least one connected player. Each team gets four random island clusters; joining is then closed.
3. **Placement.** Both teams place their fleets at the same time, in order: Carrier (5), Battleship (4), Cruiser (3), Submarine (3), Destroyer (2). Each ship takes two votes: a starting square on *Your Fleet*, then a direction (up, down, left, right). Ships may not overlap, leave the board, sit on islands, or touch another ship along an edge. Diagonal contact is allowed. Only placements that still leave room for the rest of the fleet are offered.
4. **Battle.** When both fleets are placed, Blue attacks first and the teams alternate. The attacking team votes for a square on *Enemy Waters*. A majority fires the shot, which is a HIT or a miss. A sunk ship is revealed to the attackers.
5. **Victory.** The first team to sink all five enemy ships wins. No further votes are accepted.

### Voting

- One vote per connected player per decision. A decision passes when one option has `floor(connected / 2) + 1` votes.
- Players may change their vote until a decision passes. Clicking your current choice again withdraws it.
- Vote counts are shown anonymously next to squares and direction buttons. Your own choice has a gold outline.
- A player who disconnects leaves the electorate and their vote is removed. If the remaining votes now form a majority, the decision executes immediately. Reconnecting players can vote again on the current decision.

### Team chat, teammates, Intelligence

- **Team chat** is private per team and enforced by the server (Socket.IO rooms). The last 50 messages are kept. Messages are limited to 300 characters and rate-limited (5 per 10 seconds).
- **Your Teammates** lists your own team only, with a green/grey online indicator and `Online: X / Y`.
- **Intelligence** gives each team cryptic reports about the enemy fleet: two when the battle begins, then one after every third attack. Each report states one fact that is true of the enemy's still-afloat ships (rough region, orientation, a four-row or four-column band, a count per half of the board, boundary contact, damage). Reports never name exact squares, and the underlying facts never leave the server. The last 20 reports per team are kept.

### Game Master

`/host.html` shows both boards side by side with every ship, island, hit and miss, live vote counts, both rosters with presence, placement progress, both Intelligence feeds and the full battle log.

- **Pause / Resume.** Pause works during placement and battle. While paused, every vote is rejected. Resuming restores the exact previous state.
- **Reset** (asks for confirmation) returns to a clean lobby: ships, votes, attacks, islands, Intelligence, chat and the battle log are cleared.
  - **Player policy:** connected players are **kept, with their teams**. Players who are offline at that moment are removed.
  - Tick **Remove all players on reset** for a completely fresh session. Every player is sent back to the join screen.

## Security model

- The GM authenticates over Socket.IO with `HOST_KEY`. The server compares hashes in constant time and rate-limits attempts per IP. Every GM command checks the socket's authenticated flag on the server.
- A player's identity and team are bound to the socket by the server at join/resume time. Votes and chat ignore any team or player id in the payload.
- Each player receives a view built for them: their own fleet in full, the enemy only through shots, islands and fully sunk ships. Session tokens are never included in any broadcast.
- All payloads are structure-checked. Events are rate-limited per socket, joins per IP. Names and chat are length-checked and stripped of control and bidi-override characters. Everything is rendered with `textContent`, and a strict Content-Security-Policy blocks inline scripts.

## Tests

```bash
npm test                 # syntax check + unit tests + multiplayer integration test (local server)
npm run test:unit        # engine rules only (node:test)
npm run test:integration # GM + four socket.io clients play a full game
```

The integration runner (`test/live-test.js`) starts an isolated in-process server with a random host key. It covers the 21 required scenarios: GM authentication, rejection of unauthorized GM commands, four-player joining and balancing, identity and reconnection, roster visibility, chat isolation, islands, placement legality, placement voting, attack voting, invalid attacks, hits, misses, sinking, disconnect during a vote, majority recalculation, pause/resume, Intelligence generation and privacy, a complete game to victory, and reset. Clients always wait until every participant has seen the right phase and options, and they choose targets from the legal options the server supplies. It writes `test-report.json`.

To run it against a deployed game (this **resets** that game):

```bash
TARGET_URL=https://your-app.onrender.com BATTLESHIPS_HOST_KEY=... CONFIRM_LIVE_RESET=RESET node test/live-test.js
```

The runner refuses to run without `CONFIRM_LIVE_RESET=RESET`. It also refuses to reset a game that is in progress with players online unless `ALLOW_ACTIVE_RESET=true`.

### GitHub Actions

- **CI** (`.github/workflows/ci.yml`) runs `npm test` on every push to `main` and on pull requests.
- **Test Battleships live game** (`.github/workflows/live-test.yml`) is started by hand: *GitHub → Actions → Test Battleships live game → Run workflow*.
  - `target: local` tests a temporary isolated server inside the job.
  - `target: live` tests the Render deployment at `live_url`. It requires `confirm_live_reset = RESET` and the repository secret `BATTLESHIPS_HOST_KEY`, which must equal the `HOST_KEY` set on Render.
  - The JSON report is uploaded as the `battleships-test-report` artifact.

Automated tests do not replace a visual check in real browsers. See the checklist in section 20 of the specification: grid colours, layout at 1366/1440/1920 px, tablet and mobile.

## Deploy to Render

1. Push this repository to GitHub.
2. In Render, choose **New → Blueprint** and select the repository. Render reads `render.yaml`: a Node web service built with `npm ci --omit=dev`, started with `npm start`, health check on `/healthz`, auto-deploy from `main`. Alternatively create a **Web Service** by hand with the same commands.
3. In the service's **Environment** settings, set `HOST_KEY` to a long random secret. Do not commit it.
4. In GitHub, add the same value as the repository secret `BATTLESHIPS_HOST_KEY` (*Settings → Secrets and variables → Actions*). This is only needed for live tests.
5. Update the default `live_url` in `.github/workflows/live-test.yml` if your Render URL differs.

The free Render plan sleeps when idle. The first request after a pause can take up to a minute, and the live test allows for that. A restart or redeploy clears the in-memory game.

## Project layout

```
server.js               Express + Socket.IO: auth, validation, rate limits, per-player broadcasts
src/constants.js        Board size, fleet, phases, limits, coordinate helpers
src/board.js            Islands, ship geometry, placement rules, fleet-fits search
src/game.js             Game engine: players, state machine, voting, placement, attacks, views
src/intel.js            Rule-based Intelligence generator (and fact checker used by tests)
src/ratelimit.js        Token-bucket rate limiter
public/index.html       Player dashboard (join screen + three-column layout)
public/app.js           Player client
public/host.html        Game Master dashboard
public/host.js          GM client
public/shared.js        Grid rendering helpers shared by both pages
public/style.css        Dark naval theme, grid state colours
test/engine.test.js     Unit tests for the engine
test/live-test.js       Multiplayer integration runner + JSON report
```
