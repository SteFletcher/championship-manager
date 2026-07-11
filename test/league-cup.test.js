import test from 'node:test';
import assert from 'node:assert/strict';
import { generateFixtures, computeTable } from '../src/engine/league.js';
import {
  createCup, advanceCup, inCup, cupRoundName, cupRoundNames, cupRoundCount,
  openingTarget,
} from '../src/engine/cup.js';
import { buildCalendar } from '../src/engine/season.js';
import { createRng } from '../src/engine/rng.js';

const NAMES = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'];

test('fixtures: every pair meets exactly twice, once at each venue', () => {
  const rounds = generateFixtures(NAMES);
  assert.equal(rounds.length, 22);
  const seen = new Map();
  for (const round of rounds) {
    assert.equal(round.length, 6);
    const inRound = new Set();
    for (const { home, away } of round) {
      assert.notEqual(home, away);
      assert.ok(!inRound.has(home) && !inRound.has(away), 'team plays twice in a round');
      inRound.add(home);
      inRound.add(away);
      const key = `${home}>${away}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
  }
  for (const a of NAMES) {
    for (const b of NAMES) {
      if (a === b) continue;
      assert.equal(seen.get(`${a}>${b}`), 1, `${a} should host ${b} exactly once`);
    }
  }
  // Home/away counts are balanced.
  const homeCounts = new Map(NAMES.map((n) => [n, 0]));
  for (const round of rounds) {
    for (const { home } of round) homeCounts.set(home, homeCounts.get(home) + 1);
  }
  for (const [team, count] of homeCounts) {
    assert.equal(count, 11, `${team} has ${count} home matches`);
  }
});

test('table: points, goal difference, and sorting rules', () => {
  const results = [
    { home: 'A', away: 'B', homeGoals: 2, awayGoals: 0 },
    { home: 'B', away: 'C', homeGoals: 1, awayGoals: 1 },
    { home: 'C', away: 'A', homeGoals: 0, awayGoals: 3 },
  ];
  const table = computeTable(['A', 'B', 'C'], results);
  assert.equal(table[0].team, 'A');
  assert.deepEqual(
    { pts: table[0].points, gd: table[0].goalDiff, w: table[0].won },
    { pts: 6, gd: 5, w: 2 }
  );
  assert.equal(table[1].team, 'B');
  assert.equal(table[1].points, 1);
  // Total goals for == total against across the table.
  const gf = table.reduce((s, r) => s + r.goalsFor, 0);
  const ga = table.reduce((s, r) => s + r.goalsAgainst, 0);
  assert.equal(gf, ga);
});

test('table: goal difference then goals scored break points ties', () => {
  const results = [
    { home: 'A', away: 'C', homeGoals: 3, awayGoals: 0 },
    { home: 'B', away: 'C', homeGoals: 1, awayGoals: 0 },
  ];
  const table = computeTable(['A', 'B', 'C'], results);
  assert.deepEqual(table.map((r) => r.team), ['A', 'B', 'C']);
});

test('table rejects results for unknown teams', () => {
  assert.throws(
    () => computeTable(['A'], [{ home: 'A', away: 'X', homeGoals: 1, awayGoals: 0 }]),
    /unknown team/
  );
});

test('cup sizing: opening targets and round counts for any field', () => {
  assert.equal(openingTarget(12), 8);
  assert.equal(openingTarget(24), 16);
  assert.equal(openingTarget(16), 8);
  assert.equal(cupRoundCount(12), 4);
  assert.equal(cupRoundCount(24), 5);
  assert.deepEqual(cupRoundNames(24),
    ['First Round', 'Round of 16', 'Quarter-Final', 'Semi-Final', 'Final']);
  assert.deepEqual(cupRoundNames(12),
    ['First Round', 'Quarter-Final', 'Semi-Final', 'Final']);
});

function runCupToWinner(entrants, seed) {
  const rng = createRng(seed);
  const cup = createCup(rng, entrants);
  const tiesSeen = [];
  const namesSeen = [];
  while (!cup.winner) {
    tiesSeen.push(cup.ties.length);
    namesSeen.push(cupRoundName(cup));
    const winners = cup.ties.map((t) => (rng.chance(0.5) ? t.home : t.away));
    for (const w of winners) assert.ok(inCup(cup, w));
    advanceCup(rng, cup, winners);
  }
  return { cup, tiesSeen, namesSeen };
}

test('cup: 12 entrants runs first round to final with a single winner', () => {
  const rng = createRng(7);
  const cup = createCup(rng, NAMES);
  assert.equal(cup.ties.length, 4);
  assert.equal(cup.byes.length, 4);
  // Every team is either in a tie or has a bye, exactly once.
  const everyone = [...cup.byes, ...cup.ties.flatMap((t) => [t.home, t.away])];
  assert.deepEqual([...everyone].sort(), [...NAMES].sort());

  const { cup: done, tiesSeen, namesSeen } = runCupToWinner(NAMES, 7);
  assert.deepEqual(tiesSeen, [4, 4, 2, 1]);
  assert.deepEqual(namesSeen, cupRoundNames(12));
  assert.ok(NAMES.includes(done.winner));
  assert.equal(inCup(done, done.winner), true);
  for (const l of NAMES.filter((n) => n !== done.winner)) {
    assert.equal(inCup(done, l), false);
  }
});

test('cup: 24 entrants runs five rounds to a single winner', () => {
  const names24 = [...NAMES, ...NAMES.map((n) => n + '2')];
  const first = createCup(createRng(3), names24);
  assert.equal(first.ties.length, 8);
  assert.equal(first.byes.length, 8);
  const everyone = [...first.byes, ...first.ties.flatMap((t) => [t.home, t.away])];
  assert.deepEqual([...everyone].sort(), [...names24].sort());

  const { cup: done, tiesSeen, namesSeen } = runCupToWinner(names24, 3);
  assert.deepEqual(tiesSeen, [8, 8, 4, 2, 1]);
  assert.deepEqual(namesSeen, cupRoundNames(24));
  assert.ok(names24.includes(done.winner));
});

test('cup draw is deterministic per rng seed', () => {
  const a = createCup(createRng(11), NAMES);
  const b = createCup(createRng(11), NAMES);
  assert.deepEqual(a, b);
  const c = createCup(createRng(12), NAMES);
  assert.notDeepEqual(a.ties, c.ties);
});

test('advanceCup rejects mismatched winner lists', () => {
  const rng = createRng(1);
  const cup = createCup(rng, NAMES);
  assert.throws(() => advanceCup(rng, cup, ['A']), /expected 4 winners/);
});

test('calendar: league rounds and cup days interleave in order', () => {
  for (const cupRounds of [4, 5]) {
    const calendar = buildCalendar(22, cupRounds);
    const league = calendar.filter((e) => e.type === 'league');
    const cup = calendar.filter((e) => e.type === 'cup');
    assert.equal(league.length, 22);
    assert.equal(cup.length, cupRounds);
    assert.deepEqual(league.map((e) => e.round), [...Array(22).keys()]);
    assert.deepEqual(cup.map((e) => e.cupRound), [...Array(cupRounds).keys()]);
    // Cup rounds appear in strictly increasing calendar positions.
    let prev = -1;
    for (let i = 0; i < cupRounds; i++) {
      const idx = calendar.findIndex((e) => e.type === 'cup' && e.cupRound === i);
      assert.ok(idx > prev, `cup round ${i} out of order`);
      prev = idx;
    }
  }
});
