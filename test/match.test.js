import test from 'node:test';
import assert from 'node:assert/strict';
import { simulateMatch } from '../src/engine/match.js';
import { TEAMS } from '../src/data/teams.js';
import { makeUniformTeam } from './team.test.js';

const strong = makeUniformTeam('Strong FC', 90);
const weak = makeUniformTeam('Weak FC', 55);
const evenA = makeUniformTeam('Even A', 72);
const evenB = makeUniformTeam('Even B', 72);

// ---------------------------------------------------------------------------
// Input handling
// ---------------------------------------------------------------------------

test('rejects invalid teams with a descriptive error', () => {
  assert.throws(() => simulateMatch({}, weak), /invalid home team/);
  assert.throws(() => simulateMatch(strong, { name: 'X', players: [] }), /invalid away team/);
  const badPlayer = makeUniformTeam('Bad', 70);
  badPlayer.players[4].atk = 500;
  assert.throws(() => simulateMatch(badPlayer, weak), /out of range/);
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

test('identical seeds replay the identical match', () => {
  const a = simulateMatch(strong, weak, { seed: 424242 });
  const b = simulateMatch(strong, weak, { seed: 424242 });
  assert.deepEqual(a, b);
});

test('different seeds produce different matches', () => {
  const results = new Set();
  for (let seed = 0; seed < 50; seed++) {
    const r = simulateMatch(evenA, evenB, { seed });
    results.add(JSON.stringify(r.events));
  }
  assert.ok(results.size > 45, `only ${results.size} distinct matches from 50 seeds`);
});

test('a seed is generated and reported when none is given', () => {
  const r = simulateMatch(evenA, evenB);
  assert.ok(Number.isInteger(r.seed));
  const replay = simulateMatch(evenA, evenB, { seed: r.seed });
  assert.deepEqual(replay, { ...r, seed: r.seed });
});

// ---------------------------------------------------------------------------
// Structural invariants, checked across many simulated matches
// ---------------------------------------------------------------------------

test('invariants hold across 500 matches', () => {
  for (let seed = 0; seed < 500; seed++) {
    const home = TEAMS[seed % TEAMS.length];
    const away = TEAMS[(seed + 5) % TEAMS.length];
    const r = simulateMatch(home, away, { seed });

    // Score must equal the goal events, side by side.
    const goalEvents = r.events.filter((e) => e.type === 'goal');
    assert.equal(goalEvents.filter((e) => e.side === 'home').length, r.score.home);
    assert.equal(goalEvents.filter((e) => e.side === 'away').length, r.score.away);
    assert.equal(r.scorers.home.length, r.score.home);
    assert.equal(r.scorers.away.length, r.score.away);

    for (const sideKey of ['home', 'away']) {
      const s = r.stats[sideKey];
      // Shot funnel can only narrow.
      assert.ok(s.shots >= s.onTarget, `seed ${seed}: shots < onTarget`);
      assert.ok(s.onTarget >= r.score[sideKey], `seed ${seed}: onTarget < goals`);
      // Cards cannot outnumber fouls.
      assert.ok(s.fouls >= s.yellowCards, `seed ${seed}: yellows > fouls`);
      // Nothing negative, ever.
      for (const [k, v] of Object.entries(s)) {
        assert.ok(v >= 0, `seed ${seed}: negative ${k}`);
      }
      // Event counts match stats.
      assert.equal(
        r.events.filter((e) => e.type === 'chance' && e.side === sideKey).length,
        s.shots,
        `seed ${seed}: chance events != shots`
      );
      assert.equal(
        r.events.filter((e) => e.type === 'red' && e.side === sideKey).length,
        s.redCards,
        `seed ${seed}: red events != redCards`
      );
    }

    // Possession is a complementary pair of percentages.
    assert.equal(r.stats.home.possession + r.stats.away.possession, 100);
    assert.ok(r.stats.home.possession > 0 && r.stats.home.possession < 100);

    // Sensible match length including stoppage time.
    assert.ok(r.playedMinutes >= 91 && r.playedMinutes <= 95);

    // Event log shape: chronological, in-bounds minutes, bookended.
    assert.equal(r.events[0].type, 'kickoff');
    assert.equal(r.events[r.events.length - 1].type, 'full-time');
    let prevMinute = 0;
    for (const e of r.events) {
      assert.ok(e.minute >= 1 && e.minute <= r.playedMinutes, `seed ${seed}: minute ${e.minute}`);
      assert.ok(e.minute >= prevMinute, `seed ${seed}: events out of order`);
      assert.ok(typeof e.text === 'string' && e.text.length > 0);
      assert.ok(!e.text.includes('{'), `seed ${seed}: unfilled template: ${e.text}`);
      prevMinute = e.minute;
    }
    assert.equal(r.events.filter((e) => e.type === 'half-time').length, 1);
    assert.equal(r.events.filter((e) => e.type === 'full-time').length, 1);
  }
});

test('sent-off players never feature in later events', () => {
  let redsSeen = 0;
  for (let seed = 0; seed < 2000 && redsSeen < 25; seed++) {
    const r = simulateMatch(evenA, evenB, { seed });
    const dismissed = new Map(); // player -> minute of red card
    for (const e of r.events) {
      if (e.player && dismissed.has(e.player) && e.minute > dismissed.get(e.player)) {
        assert.fail(
          `seed ${seed}: ${e.player} sent off in minute ${dismissed.get(e.player)} ` +
          `but appears in minute ${e.minute} (${e.type})`
        );
      }
      if (e.type === 'red') {
        dismissed.set(e.player, e.minute);
        redsSeen++;
      }
    }
  }
  assert.ok(redsSeen >= 25, `only saw ${redsSeen} red cards; engine may never send players off`);
});

test('every event player belongs to the right team', () => {
  const rosterA = new Set(evenA.players.map((p) => p.name));
  const rosterB = new Set(evenB.players.map((p) => p.name));
  for (let seed = 0; seed < 100; seed++) {
    const r = simulateMatch(evenA, evenB, { seed });
    for (const e of r.events) {
      if (!e.player) continue;
      const roster = e.side === 'home' ? rosterA : rosterB;
      assert.ok(roster.has(e.player), `seed ${seed}: ${e.player} not in ${e.side} roster`);
    }
  }
});

test('goalkeepers never take shots', () => {
  for (let seed = 0; seed < 200; seed++) {
    const r = simulateMatch(evenA, evenB, { seed });
    const keeperNames = new Set(
      [...evenA.players, ...evenB.players].filter((p) => p.pos === 'GK').map((p) => p.name)
    );
    for (const e of r.events) {
      if (['chance', 'goal', 'save', 'miss', 'block'].includes(e.type)) {
        assert.ok(!keeperNames.has(e.player), `seed ${seed}: keeper shot`);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// Statistical sanity, all with fixed seeds so results are reproducible
// ---------------------------------------------------------------------------

function runMany(home, away, n, options = {}) {
  const tally = { homeWins: 0, awayWins: 0, draws: 0, goals: 0, shots: 0, cards: 0 };
  for (let seed = 0; seed < n; seed++) {
    const r = simulateMatch(home, away, { seed, ...options });
    if (r.score.home > r.score.away) tally.homeWins++;
    else if (r.score.away > r.score.home) tally.awayWins++;
    else tally.draws++;
    tally.goals += r.score.home + r.score.away;
    tally.shots += r.stats.home.shots + r.stats.away.shots;
    tally.cards += r.stats.home.yellowCards + r.stats.away.yellowCards;
  }
  return tally;
}

const N = 1000;

test('a much stronger team wins the large majority of matches', () => {
  const t = runMany(strong, weak, N, { homeAdvantage: false });
  assert.ok(t.homeWins / N > 0.6, `strong team only won ${t.homeWins}/${N}`);
  assert.ok(t.awayWins / N < 0.2, `weak team won ${t.awayWins}/${N}`);

  // And it holds away from home too.
  const rev = runMany(weak, strong, N, { homeAdvantage: false });
  assert.ok(rev.awayWins / N > 0.6, `strong team only won ${rev.awayWins}/${N} away`);
});

test('evenly matched teams are balanced on neutral ground', () => {
  const t = runMany(evenA, evenB, N, { homeAdvantage: false });
  assert.ok(Math.abs(t.homeWins - t.awayWins) < N * 0.08,
    `imbalanced: ${t.homeWins} home wins vs ${t.awayWins} away wins`);
  assert.ok(t.draws / N > 0.12 && t.draws / N < 0.45, `draw rate ${t.draws / N}`);
});

test('home advantage tilts results toward the home side', () => {
  const t = runMany(evenA, evenB, N);
  assert.ok(t.homeWins > t.awayWins * 1.15,
    `home advantage missing: ${t.homeWins} vs ${t.awayWins}`);
});

test('goals per match are in a realistic football range', () => {
  const t = runMany(evenA, evenB, N);
  const avgGoals = t.goals / N;
  assert.ok(avgGoals > 1.8 && avgGoals < 3.8, `avg goals ${avgGoals}`);
});

test('shots and cards per match look like real football', () => {
  const t = runMany(evenA, evenB, N);
  const avgShots = t.shots / N;
  const avgCards = t.cards / N;
  assert.ok(avgShots > 14 && avgShots < 34, `avg total shots ${avgShots}`);
  assert.ok(avgCards > 1 && avgCards < 7, `avg yellow cards ${avgCards}`);
});

test('mismatch produces a healthy but bounded scoreline gap', () => {
  let strongGoals = 0;
  let weakGoals = 0;
  let blowouts = 0;
  for (let seed = 0; seed < N; seed++) {
    const r = simulateMatch(strong, weak, { seed, homeAdvantage: false });
    strongGoals += r.score.home;
    weakGoals += r.score.away;
    if (r.score.home >= 9) blowouts++;
  }
  assert.ok(strongGoals / N > weakGoals / N + 0.6, 'no meaningful goal gap');
  assert.ok(weakGoals / N > 0.2, 'weak team can never score at all');
  assert.ok(blowouts / N < 0.02, `absurd scorelines too common: ${blowouts}`);
});

test('the better team out-possesses the weaker one on average', () => {
  let possession = 0;
  for (let seed = 0; seed < 300; seed++) {
    const r = simulateMatch(strong, weak, { seed, homeAdvantage: false });
    possession += r.stats.home.possession;
  }
  const avg = possession / 300;
  assert.ok(avg > 55 && avg < 80, `strong team possession ${avg}`);
});
