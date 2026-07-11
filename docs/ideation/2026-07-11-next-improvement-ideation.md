---
date: 2026-07-11
topic: next-improvement
focus: Next best improvement given the current feature set
mode: repo-grounded
---

# Ideation: Next Best Improvement for Champman

## Grounding Context

Browser CM 99/00-style career game, pure ES modules, engine (src/engine) shared
verbatim between UI and 128-test node:test suite. Current systems: resumable
MatchSim (pause/subs/auto-pause on key moments, ET+pens), 12-club league + cup,
18-player squads (condition/form/morale/contracts/development), transfers with
negotiation and AI bids, fanbase-driven attendance economy, board confidence &
sacking, news/awards, save/load. Deferred earlier: promotion/relegation, Europe,
internationals, hotseat.

## Topic Axes

- Match-day interactivity (the live match loop)
- Season & world structure (competitions, stakes)
- Squad & player depth (scouting, development, interaction)
- Economy & club-building (money sinks, infrastructure)
- Career & meta (reputation, job market, history)

## Ranked Ideas

### 1. In-match tactical management
**Status:** Explored — implemented 2026-07-11
**Description:** Change formation and mentality during any pause (including the
new auto-pauses), and give AI managers the same brain: trailing sides push
attacking late, leading sides shut up shop, sides down to ten men drop deeper.
**Axis:** Match-day interactivity
**Basis:** `direct:` `pauseMatch()` opens only the substitution panel; the
engine reads `setup.mentality` live each minute (MENTALITY_MODS) but exposes no
setter, and `slotCounts` is frozen at kickoff — so the decision moments the
auto-pause feature just created offer only one lever (subs). AI sides never
change approach regardless of score.
**Rationale:** It completes the loop the last two features built toward: the
game now *stops and asks you a question* at red cards and half time, but you
can't answer with tactics. The match is the most-repeated unit in the game
(26+ per season), so depth here pays out every single week. Engine-first and
highly testable (statistical: mentality switch shifts goal rates after the
switch; structural: formation remap preserves players, sent-off stay off).
**Downsides:** Slot-remapping logic has edge cases (missing units after reds).
**Confidence:** 90%
**Complexity:** Medium

### 2. Promotion/relegation with a second division
**Status:** Explored — implemented 2026-07-11
**Description:** Add a 12-club second tier with movement between divisions,
adjusted board expectations, and the cup spanning all 24 clubs.
**Axis:** Season & world structure
**Basis:** `direct:` explicitly deferred at build time; finishing 11th vs 12th
currently differs only in board confidence — the bottom half of the table has
no dread, which is half of what makes a CM season tense.
**Rationale:** Biggest single expansion of stakes and career longevity.
**Downsides:** Large: doubles world size, reworks fixtures/expectations/cup and
several UI screens; payoff is back-loaded to season end.
**Confidence:** 75%
**Complexity:** High

### 3. Stadium expansion as a money sink
**Status:** Explored — implemented 2026-07-11
**Description:** Board-approved capacity expansions costing millions, unlocking
higher gates once the fanbase outgrows the ground.
**Axis:** Economy & club-building
**Basis:** `direct:` fanbase caps at 1.6× capacity while balances accumulate
with only transfers to spend on — successful clubs hit an income ceiling with
idle cash.
**Rationale:** Closes the economy loop the attendance feature opened.
**Downsides:** Only bites after multiple successful seasons.
**Confidence:** 70%
**Complexity:** Low-Medium

### 4. Manager reputation and the job market
**Status:** Explored — implemented 2026-07-11
**Description:** Getting sacked offers jobs at lesser clubs instead of ending
the career; strong seasons attract offers from bigger clubs.
**Axis:** Career & meta
**Basis:** `direct:` the sacked branch in `renderHub` is a dead end (wipe save,
start over) — failure currently deletes the story instead of continuing it.
**Rationale:** Turns the sack from a game-over screen into a narrative.
**Downsides:** Only activates on failure/extremes; medium UI surface.
**Confidence:** 60%
**Complexity:** Medium

### 5. Pre-match opposition report
**Status:** Explored — implemented 2026-07-11
**Description:** Show the opponent's likely XI, form guide, and danger men on
the pre-match screen.
**Axis:** Match-day interactivity
**Basis:** `direct:` the prematch screen renders only the user's lineup; there
is no information to base tactical choices on.
**Rationale:** Cheap, and gives the tactics choices (idea 1) something to react to.
**Downsides:** Information-only; no new mechanics.
**Confidence:** 55%
**Complexity:** Low

### 6. Scouting and attribute masking
**Status:** Explored — implemented 2026-07-11
**Description:** Hide exact attributes of other clubs' players behind scout
reports with ranges that sharpen over time.
**Axis:** Squad & player depth
**Basis:** `reasoned:` with all attributes visible, transfers reduce to sorting
a spreadsheet; CM's transfer tension came from imperfect information. No direct
code signal — this is a design-judgment call.
**Rationale:** Restores risk to the transfer market.
**Downsides:** Adds friction some players dislike; touches many UI tables.
**Confidence:** 50%
**Complexity:** Medium

## Rejection Summary

| # | Idea | Reason Rejected |
|---|------|-----------------|
| 1 | Momentum meter / live xG graph | Cosmetic; no mechanic attached; weak basis |
| 2 | "Holiday" multi-week simulate button | Below ambition floor; minor UX nicety |
| 3 | League stats pages (assists, discipline) | Below floor; top scorers already on Club screen |
| 4 | Dynamic board expectations / club stature drift | Duplicates weaker halves of ideas 2 and 4 |
| 5 | Roguelike-style career "runs" with unlocks | Breaks the CM identity of the subject |
| 6 | Skip pre-match screen when lineup unchanged | Trivial; not worth a slot |
