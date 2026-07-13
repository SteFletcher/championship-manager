# Championship Manager

**[Play the game online](https://stefletcher.github.io/championship-manager/)**

A retro football management career game that runs entirely in the browser,
modelled on Championship Manager 99/00. Take charge of one of 12 clubs and
manage squads, tactics, transfers, finances and the board across full
seasons of league and cup football.

## Run it

```sh
npm run serve       # http://localhost:8123
```

No build step. The UI (`index.html`, `js/app.js`) loads the engine as
native ES modules. Games auto-save to localStorage after every week.

## Features

- **Career mode** — pick any of 24 clubs across two divisions, get judged
  against board expectations, earn prize money, and build a managerial
  reputation. Getting sacked opens a job market — take over a lesser club
  and fight back — and strong seasons attract offers from bigger clubs.
- **Promotion & relegation** — two 12-club divisions with two up, two down
  each season, dynamic board expectations, and a 24-club knockout cup.
- **In-match tactics** — change formation and mentality at any pause, and
  AI managers do the same: chasing when behind, shutting up shop in front.
- **Scouting** — other clubs' attributes show as estimate ranges until a
  £15k scout report (one week) reveals the truth. Pre-match opposition
  reports show the opponent's form, predicted XI, and danger man.
- **Stadium expansion** — when the fanbase fills the ground, invest the
  gate money in new seats (eight-week builds; AI boards do it too).
- **Squads** — 18 players per club with age, attributes, hidden
  consistency/injury-proneness, condition, form, morale, wages, values,
  and contracts. End-of-season development, aging, retirements, youth intake.
- **Tactics** — five formations, three mentalities, full team selection
  with click-to-swap XI/bench/reserves and out-of-position penalties.
- **Live match day** — resumable minute-by-minute engine: pause any time
  and make substitutions, with **automatic pauses at key moments** (half
  time, red cards, extra time, and injuries to your players — your side is
  left a man short until you react). Per-player live ratings out of 10 on
  a formation pitch view, commentary, full stats. Cup ties go to extra
  time and penalty shootouts. Instant speed skips the interruptions.
- **Season structure** — 22-round double round-robin league with a live
  table and all results simulated, plus a knockout cup with drawn rounds.
- **Injuries & suspensions** — engine injuries carry real durations;
  five bookings or a red card bring bans; unavailable players can't be picked.
- **Transfers** — search with filters, valuation-based negotiation
  (accept/counter/reject), player willingness, squad-protection rules,
  AI bids for your players, AI-to-AI transfers, free agents, transfer listing.
- **Finances** — balance, transfer budget, weekly wages, prize money, and
  a **fanbase-driven attendance economy**: every club starts with a core
  of supporters that grows with wins and strong finishes (and drains away
  through defeats), and home gate receipts follow the actual attendance,
  capped by the stadium.
- **News inbox** — injuries, bans, offers (with accept/reject actions),
  board reactions, monthly Player of the Month, season awards.

## Layout

- `src/engine/rng.js` — seeded RNG (mulberry32) with serializable state;
  all randomness flows through it, so matches and careers replay exactly.
- `src/engine/players.js` — player creation, valuation, development.
- `src/engine/team.js` — formations, lineup validation, XI selection, ratings.
- `src/engine/match.js` — `MatchSim`: resumable minute-by-minute simulation
  (pause/subs), injuries, cards, condition, mentality/formation effects,
  extra time and shootouts. `simulateMatch()` wraps it for one-shot use.
- `src/engine/league.js` / `cup.js` / `season.js` — fixtures, table,
  knockout draws, season calendar.
- `src/engine/transfers.js` — valuations, negotiation and AI market logic.
- `src/engine/game.js` — the career: advancing weeks, applying results,
  injuries/bans bookkeeping, finances, board confidence, news, awards,
  season end, save/restore.
- `src/data/teams.js` — 12 fictional clubs; squads generated
  deterministically from the club name.
- `js/app.js` — UI only: start screen, management hub, and match day.

## Tests

```sh
npm test                     # 122 engine + game tests (node:test, no deps)
node test/browser-smoke.js   # end-to-end career flow in a real browser;
                             # needs `npm run serve` and a Chromium-family
                             # browser (defaults to Brave)
```

The suite covers RNG uniformity, team/squad validity, match determinism
(same seed → identical match), structural invariants across hundreds of
matches (score ≡ goal events, shot funnels, possession, sent-off players
never reappear), statistical realism over thousands of sims (goals, shots,
cards, home advantage, mismatch behaviour), substitution/injury rules,
extra time and shootouts, fixture and table correctness, cup progression,
transfer negotiation and squad-protection rules, multi-season headless
simulation invariants, and save/restore roundtrips that continue
deterministically.
