import test from 'node:test';
import assert from 'node:assert/strict';
import { simulateMatch } from '../src/engine/match.js';
import { TEAMS } from '../src/data/teams.js';
import { makeUniformTeam } from './team.test.js';

const evenA = makeUniformTeam('Even A', 72);
const evenB = makeUniformTeam('Even B', 72);

const STAT_KEYS = [
  'passes', 'tackles', 'shots', 'onTarget', 'goals',
  'assists', 'saves', 'fouls', 'yellow', 'red',
];

test('player stats reconcile with team stats and events across 300 matches', () => {
  for (let seed = 0; seed < 300; seed++) {
    const home = TEAMS[seed % TEAMS.length];
    const away = TEAMS[(seed + 3) % TEAMS.length];
    const r = simulateMatch(home, away, { seed, timeline: false });

    for (const sideKey of ['home', 'away']) {
      const lines = r.playerStats[sideKey];
      const teamStats = r.stats[sideKey];
      // Matchday squad: 11 starters plus any bench players.
      assert.ok(lines.length >= 11, `seed ${seed}: only ${lines.length} lines`);
      assert.equal(lines.filter((l) => l.started).length, 11);

      const sum = (key) => lines.reduce((acc, l) => acc + l[key], 0);
      assert.equal(sum('goals'), r.score[sideKey], `seed ${seed}: goals mismatch`);
      assert.equal(sum('shots'), teamStats.shots, `seed ${seed}: shots mismatch`);
      assert.equal(sum('onTarget'), teamStats.onTarget, `seed ${seed}: onTarget mismatch`);
      assert.equal(sum('yellow'), teamStats.yellowCards, `seed ${seed}: yellows mismatch`);
      assert.equal(sum('red'), teamStats.redCards, `seed ${seed}: reds mismatch`);
      // Team fouls count every foul; player lines only miss none.
      assert.equal(sum('fouls'), teamStats.fouls, `seed ${seed}: fouls mismatch`);
      // At most one assist per goal.
      assert.ok(sum('assists') <= r.score[sideKey], `seed ${seed}: too many assists`);

      for (const l of lines) {
        assert.ok(l.rating >= 1 && l.rating <= 10, `seed ${seed}: rating ${l.rating}`);
        assert.ok(l.shots >= l.onTarget && l.onTarget >= l.goals,
          `seed ${seed}: ${l.name} shot funnel broken`);
        for (const key of STAT_KEYS) {
          assert.ok(l[key] >= 0 && Number.isInteger(l[key]),
            `seed ${seed}: ${l.name} ${key} = ${l[key]}`);
        }
        // Only whoever kept goal makes saves; natural keepers never shoot.
        if (l.slot !== 'GK') assert.equal(l.saves, 0, `seed ${seed}: outfield save`);
        if (l.pos === 'GK') assert.equal(l.shots, 0, `seed ${seed}: keeper shot`);
        assert.ok(l.red <= 1 && l.yellow <= 2, `seed ${seed}: card overflow`);
      }

      // Saves reconcile: opposition shots on target = goals conceded + saves
      // (summed across every keeper used, including emergency ones).
      const oppKey = sideKey === 'home' ? 'away' : 'home';
      assert.equal(
        sum('saves') + r.score[oppKey],
        r.stats[oppKey].onTarget,
        `seed ${seed}: keeper saves don't reconcile`
      );
    }
  }
});

test('ratings respond to events: scorers rise, sent-off players sink', () => {
  let checkedGoal = 0;
  let checkedRed = 0;
  for (let seed = 0; seed < 400 && (checkedGoal < 30 || checkedRed < 10); seed++) {
    const r = simulateMatch(evenA, evenB, { seed });
    for (const e of r.events) {
      if (e.type !== 'goal' && e.type !== 'red') continue;
      if (e.minute < 2) continue; // no pre-event snapshot exists
      // A goal and a red card for the same player in the same minute would
      // offset each other; skip those rare cases.
      const sameMinuteOffsets = r.events.some(
        (o) => o !== e && o.player === e.player && o.minute === e.minute &&
          (o.type === 'goal' || o.type === 'red')
      );
      if (sameMinuteOffsets) continue;

      const before = r.timeline[e.minute - 2]; // state after the prior minute
      const after = r.timeline[e.minute - 1]; // state after the event minute
      const lineOf = (snap) => snap[e.side].find((l) => l.name === e.player);
      if (e.type === 'goal') {
        if (lineOf(before).rating > 8.8) continue; // clamped near the ceiling
        assert.ok(lineOf(after).rating > lineOf(before).rating,
          `seed ${seed}: scorer rating did not rise`);
        checkedGoal++;
      } else {
        if (lineOf(before).rating < 2.4) continue; // clamped near the floor
        assert.ok(lineOf(after).rating < lineOf(before).rating,
          `seed ${seed}: dismissed player rating did not fall`);
        checkedRed++;
      }
    }
  }
  assert.ok(checkedGoal >= 30 && checkedRed >= 10,
    `insufficient samples: ${checkedGoal} goals, ${checkedRed} reds`);
});

test('average ratings sit in a sensible CM-like band', () => {
  let total = 0;
  let count = 0;
  let min = 11;
  let max = 0;
  for (let seed = 0; seed < 200; seed++) {
    const r = simulateMatch(evenA, evenB, { seed, timeline: false });
    for (const sideKey of ['home', 'away']) {
      for (const l of r.playerStats[sideKey]) {
        total += l.rating;
        count++;
        min = Math.min(min, l.rating);
        max = Math.max(max, l.rating);
      }
    }
  }
  const avg = total / count;
  assert.ok(avg > 5.8 && avg < 7.5, `average rating ${avg}`);
  assert.ok(max > 8, `no standout performances, max ${max}`);
  assert.ok(min < 5.5, `no poor performances, min ${min}`);
});

test('players make a realistic volume of passes and tackles', () => {
  let passes = 0;
  let tackles = 0;
  const N = 200;
  for (let seed = 0; seed < N; seed++) {
    const r = simulateMatch(evenA, evenB, { seed, timeline: false });
    for (const sideKey of ['home', 'away']) {
      passes += r.playerStats[sideKey].reduce((a, l) => a + l.passes, 0);
      tackles += r.playerStats[sideKey].reduce((a, l) => a + l.tackles, 0);
    }
  }
  const passesPerTeam = passes / (N * 2);
  const tacklesPerTeam = tackles / (N * 2);
  assert.ok(passesPerTeam > 120 && passesPerTeam < 400, `passes/team ${passesPerTeam}`);
  assert.ok(tacklesPerTeam > 8 && tacklesPerTeam < 40, `tackles/team ${tacklesPerTeam}`);
});

test('timeline snapshots every minute and converges on the final stats', () => {
  for (let seed = 0; seed < 50; seed++) {
    const r = simulateMatch(evenA, evenB, { seed });
    assert.equal(r.timeline.length, r.playedMinutes);
    r.timeline.forEach((snap, i) => {
      assert.equal(snap.minute, i + 1);
      assert.equal(snap.home.length, 11);
      assert.equal(snap.away.length, 11);
    });
    // The last snapshot must equal the final player stats exactly.
    const last = r.timeline[r.timeline.length - 1];
    assert.deepEqual(last.home, r.playerStats.home);
    assert.deepEqual(last.away, r.playerStats.away);
  }
});

test('counting stats never decrease across the timeline', () => {
  for (let seed = 0; seed < 30; seed++) {
    const r = simulateMatch(evenA, evenB, { seed });
    for (const sideKey of ['home', 'away']) {
      for (let i = 1; i < r.timeline.length; i++) {
        const prev = r.timeline[i - 1][sideKey];
        const cur = r.timeline[i][sideKey];
        for (let p = 0; p < 11; p++) {
          assert.equal(cur[p].name, prev[p].name, 'player order changed');
          for (const key of STAT_KEYS) {
            assert.ok(cur[p][key] >= prev[p][key],
              `seed ${seed}: ${cur[p].name} ${key} decreased at minute ${i + 1}`);
          }
        }
      }
    }
  }
});

test('sent-off players accrue no further stats', () => {
  let checked = 0;
  for (let seed = 0; seed < 600 && checked < 15; seed++) {
    const r = simulateMatch(evenA, evenB, { seed });
    for (const e of r.events) {
      if (e.type !== 'red') continue;
      checked++;
      const atRed = r.timeline[e.minute - 1][e.side].find((l) => l.name === e.player);
      const atEnd = r.playerStats[e.side].find((l) => l.name === e.player);
      for (const key of STAT_KEYS) {
        assert.equal(atEnd[key], atRed[key],
          `seed ${seed}: ${e.player} gained ${key} after red card`);
      }
    }
  }
  assert.ok(checked >= 15, `only ${checked} red cards seen`);
});

test('a clean sheet lifts the back line at full time', () => {
  let checked = 0;
  for (let seed = 0; seed < 200 && checked < 20; seed++) {
    const r = simulateMatch(evenA, evenB, { seed });
    for (const sideKey of ['home', 'away']) {
      const conceded = sideKey === 'home' ? r.score.away : r.score.home;
      if (conceded !== 0) continue;
      checked++;
      const beforeFT = r.timeline[r.timeline.length - 2][sideKey];
      const atFT = r.playerStats[sideKey];
      const keeperBefore = beforeFT.find((l) => l.pos === 'GK');
      const keeperAfter = atFT.find((l) => l.pos === 'GK');
      assert.ok(keeperAfter.rating >= keeperBefore.rating,
        `seed ${seed}: keeper not rewarded for clean sheet`);
    }
  }
  assert.ok(checked >= 20, `only ${checked} clean sheets seen`);
});

test('timeline can be disabled for bulk simulation', () => {
  const r = simulateMatch(evenA, evenB, { seed: 1, timeline: false });
  assert.equal(r.timeline, null);
  // And disabling it must not change the match itself.
  const full = simulateMatch(evenA, evenB, { seed: 1 });
  assert.deepEqual(r.score, full.score);
  assert.deepEqual(r.events, full.events);
  assert.deepEqual(r.playerStats, full.playerStats);
});

test('determinism still holds with player stats and timeline', () => {
  const a = simulateMatch(evenA, evenB, { seed: 777 });
  const b = simulateMatch(evenA, evenB, { seed: 777 });
  assert.deepEqual(a, b);
});
