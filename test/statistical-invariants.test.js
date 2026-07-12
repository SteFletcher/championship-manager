// Statistical realism invariants (EE-1).
//
// These bands encode REALISM, not current behaviour, and are the permanent
// contract for every engine milestone: goldens may be re-pinned when a
// milestone deliberately changes outcomes, but these must always pass.
// Never widen a band to make a change fit — a failure here means the
// engine stopped resembling football.
//
// The sample is a fixed seed set, so the suite is deterministic: it checks
// one known sample against the bands, no flake.

import test from 'node:test';
import assert from 'node:assert/strict';
import { simulateMatch } from '../src/engine/match.js';
import { makeXi } from './golden/setups.js';

const SIMS = 400;
const homeXi = makeXi('Invariant Home', 70);
const awayXi = makeXi('Invariant Away', 70);

function inBand(value, lo, hi, label) {
  assert.ok(value >= lo && value <= hi,
    `${label} = ${value.toFixed(3)} outside realism band [${lo}, ${hi}]`);
}

// One pass over the fixed seed set; individual tests assert on the tallies.
const t = {
  goals: 0, homeWins: 0, draws: 0, awayWins: 0, nilNil: 0, fiveUp: 0,
  shots: 0, onTarget: 0, yellows: 0, reds: 0,
};
for (let i = 0; i < SIMS; i++) {
  const r = simulateMatch(homeXi, awayXi, { seed: 1000 + i, timeline: false });
  const { home, away } = r.score;
  t.goals += home + away;
  if (home > away) t.homeWins++;
  else if (home < away) t.awayWins++;
  else t.draws++;
  if (home === 0 && away === 0) t.nilNil++;
  if (home >= 5 || away >= 5) t.fiveUp++;
  for (const s of [r.stats.home, r.stats.away]) {
    t.shots += s.shots;
    t.onTarget += s.onTarget;
    t.yellows += s.yellowCards;
    t.reds += s.redCards;
  }
}

test('goals per match are football-like', () => {
  inBand(t.goals / SIMS, 2.2, 3.2, 'goals/match');
});

test('home advantage exists and is bounded', () => {
  inBand(t.homeWins / SIMS, 0.38, 0.52, 'home win rate');
  inBand(t.draws / SIMS, 0.20, 0.32, 'draw rate');
  inBand(t.awayWins / SIMS, 0.22, 0.34, 'away win rate');
});

test('scoreline tails are Poisson-like', () => {
  inBand(t.nilNil / SIMS, 0.04, 0.12, '0-0 rate');
  assert.ok(t.fiveUp / SIMS < 0.06,
    `blowout rate ${(t.fiveUp / SIMS).toFixed(3)} ≥ 0.06 — either side scoring 5+ must stay rare`);
});

test('shot volumes and accuracy are realistic', () => {
  inBand(t.shots / (SIMS * 2), 7, 16, 'shots per side');
  inBand(t.onTarget / t.shots, 0.30, 0.55, 'on-target share');
});

test('discipline is realistic', () => {
  inBand((t.yellows + t.reds) / SIMS, 1.5, 5, 'cards/match');
  assert.ok(t.reds / SIMS < 0.3, `reds/match ${(t.reds / SIMS).toFixed(3)} ≥ 0.3`);
});

test('equal sides split possession evenly without home advantage', () => {
  let possession = 0;
  const n = 200;
  for (let i = 0; i < n; i++) {
    const r = simulateMatch(homeXi, awayXi, {
      seed: 5000 + i, timeline: false, homeAdvantage: false,
    });
    possession += r.stats.home.possession;
  }
  inBand(possession / n, 44, 56, 'mean home possession (no advantage)');
});

test('quality wins: a stronger XI beats a weaker one', () => {
  const strong = makeXi('Invariant Strong', 80);
  const weak = makeXi('Invariant Weak', 65);
  let strongWins = 0;
  const n = 200;
  for (let i = 0; i < n; i++) {
    // Strong side plays away, so the edge shown is quality, not venue.
    const r = simulateMatch(weak, strong, { seed: 9000 + i, timeline: false });
    if (r.score.away > r.score.home) strongWins++;
  }
  assert.ok(strongWins / n > 0.52,
    `stronger XI win rate ${(strongWins / n).toFixed(3)} ≤ 0.52 — quality must matter`);
});
