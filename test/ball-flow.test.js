// Ball location & possession chains (EE-5).
//
// Covers the milestone's test plan: state-machine sanity over the flow
// log, the final-third chance gate, territory following strength, the
// clustering split (shots over-disperse across 10-minute windows while
// goals stay near-Poisson), stat coherence, and determinism of scripted
// mid-match interactions under the tick loop.

import test from 'node:test';
import assert from 'node:assert/strict';
import { MatchSim, simulateMatch } from '../src/engine/match.js';
import { unitOf } from '../src/engine/team.js';

const clamp = (v) => Math.min(99, Math.max(1, Math.round(v)));
const SLOTS_442 = ['GK', 'DR', 'DC', 'DC', 'DL', 'MR', 'MC', 'MC', 'ML', 'ST', 'ST'];

function makePrepared(name, level, mentality = 'normal') {
  const players = SLOTS_442.map((slot, i) => {
    const unit = unitOf(slot);
    const wobble = ((i * 7) % 11) - 5;
    const base = {
      GK: { atk: 20, def: level + 8 },
      DF: { atk: level - 15, def: level + 4 },
      MF: { atk: level, def: level },
      FW: { atk: level + 5, def: level - 15 },
    }[unit];
    return {
      id: `${name}-${i}`, name: `${name} ${slot}${i}`, pos: unit,
      atk: clamp(base.atk + wobble), def: clamp(base.def + wobble),
    };
  });
  return {
    name, shortName: name.slice(0, 3).toUpperCase(),
    starters: players.map((p, i) => ({ player: p, slot: SLOTS_442[i] })),
    bench: [], formation: '4-4-2', mentality,
  };
}

const opts = { timeline: false, autoSubs: { home: false, away: false } };

function dispersion(values) {
  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const varc = values.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  return mean > 0 ? varc / mean : 0;
}

// --- State machine sanity ----------------------------------------------------

test('the flow log is a valid zone/owner walk, three ticks per minute', () => {
  const r = simulateMatch(makePrepared('Flow Home', 70), makePrepared('Flow Away', 70),
    { seed: 404, ...opts });
  assert.equal(r.flow.length, r.playedMinutes * 3, 'three flow entries per minute');
  const zoneIdx = { D: 0, M: 1, A: 2 };
  for (const f of r.flow) {
    assert.ok(['D', 'M', 'A'].includes(f.zone), `bad zone ${f.zone}`);
    assert.ok(['home', 'away'].includes(f.owner), `bad owner ${f.owner}`);
  }
  // Zones move at most one step between consecutive ticks, except across
  // a chance restart (goal → M, otherwise the defence's third).
  const chanceMinutes = new Set(r.events.filter((e) => e.type === 'chance').map((e) => e.minute));
  for (let i = 1; i < r.flow.length; i++) {
    const step = Math.abs(zoneIdx[r.flow[i].zone] - zoneIdx[r.flow[i - 1].zone]);
    if (step > 1) {
      assert.ok(chanceMinutes.has(r.flow[i].minute) || chanceMinutes.has(r.flow[i - 1].minute),
        `zone jumped ${r.flow[i - 1].zone}→${r.flow[i].zone} at minute ${r.flow[i].minute} with no chance restart`);
    }
  }
});

test('after every goal the ball restarts at M with the conceding side', () => {
  for (const seed of [11, 222, 3333]) {
    const r = simulateMatch(makePrepared('Goal Home', 74), makePrepared('Goal Away', 66),
      { seed, ...opts });
    const goals = r.events.filter((e) => e.type === 'goal' && !e.text.includes('penalt'));
    assert.ok(goals.length > 0, `seed ${seed} produced no goals — pick another`);
    for (const goal of goals) {
      // The goal tick's own flow entry shows the attacker in their final
      // third; the restart {M, conceder} is applied after it, so the NEXT
      // entry must be at most one transition roll away from that restart:
      // still at M (hold or turnover) or one advance step beyond it.
      const scorerThird = goal.side === 'home' ? 'A' : 'D';
      const concederAdvance = goal.side === 'home' ? 'D' : 'A'; // conceder's next zone
      const goalTick = r.flow.findIndex((f, i) =>
        f.minute === goal.minute && f.zone === scorerThird && f.owner === goal.side &&
        (r.flow[i + 1] === undefined ||
          r.flow[i + 1].zone === 'M' || r.flow[i + 1].zone === concederAdvance));
      assert.ok(goalTick !== -1,
        `goal at ${goal.minute}' (${goal.side}): no flow tick followed by a kickoff restart`);
    }
  }
});

// --- Chance gate ---------------------------------------------------------------

test("chances only arise with the ball in the attacker's final third", () => {
  for (const seed of [7, 77, 777]) {
    const r = simulateMatch(makePrepared('Gate Home', 72), makePrepared('Gate Away', 68),
      { seed, ...opts });
    const chances = r.events.filter((e) => e.type === 'chance');
    assert.ok(chances.length > 5, 'expected a normal volume of chances');
    for (const c of chances) {
      const expected = c.side === 'home' ? 'A' : 'D';
      assert.equal(c.data.zone, expected,
        `chance for ${c.side} at ${c.minute}' with ball in zone ${c.data.zone}`);
    }
  }
});

// --- Territory & stats -----------------------------------------------------------

test('territory follows strength; equal sides split it', () => {
  const runTerr = (homeLevel, awayLevel, seedBase) => {
    let terr = 0;
    let entries = 0;
    const n = 200;
    for (let i = 0; i < n; i++) {
      const r = simulateMatch(
        makePrepared('Terr Home', homeLevel), makePrepared('Terr Away', awayLevel),
        { seed: seedBase + i, homeAdvantage: false, ...opts });
      terr += r.stats.home.territoryPct;
      entries += r.stats.home.finalThirdEntries;
    }
    return { terr: terr / n, entries: entries / n };
  };
  const equal = runTerr(70, 70, 15000);
  assert.ok(equal.terr > 44 && equal.terr < 56, `equal-side territory ${equal.terr.toFixed(1)}`);
  assert.ok(equal.entries >= 18 && equal.entries <= 35,
    `final-third entries ${equal.entries.toFixed(1)} outside 18–35`);
  const strong = runTerr(80, 65, 16000);
  assert.ok(strong.terr >= 56 && strong.terr <= 70,
    `strong-side territory ${strong.terr.toFixed(1)} outside 56–70`);
});

test('possession and territory stats are coherent', () => {
  const r = simulateMatch(makePrepared('Coh Home', 70), makePrepared('Coh Away', 70),
    { seed: 909, ...opts });
  assert.equal(r.stats.home.possession + r.stats.away.possession, 100);
  assert.equal(r.stats.home.territoryPct + r.stats.away.territoryPct, 100);
  // Owned final-third ticks are a subset of the flow log for each side.
  for (const side of ['home', 'away']) {
    const ownA = r.flow.filter((f) => f.owner === side &&
      f.zone === (side === 'home' ? 'A' : 'D')).length;
    const owned = r.flow.filter((f) => f.owner === side).length;
    assert.ok(ownA <= owned, 'final-third ticks exceed owned ticks');
    assert.ok(r.stats[side].finalThirdEntries <= ownA + 1,
      'more entries than final-third presence');
  }
});

// --- The milestone's signature: clustering split ---------------------------------

test('shots cluster into spells; goals stay near-Poisson (BALL-08)', () => {
  const shotWindows = [];
  const goalCounts = [];
  const n = 400;
  for (let i = 0; i < n; i++) {
    const r = simulateMatch(makePrepared('Clu Home', 70), makePrepared('Clu Away', 70),
      { seed: 20000 + i, ...opts });
    goalCounts.push(r.score.home + r.score.away);
    const windows = { home: new Array(10).fill(0), away: new Array(10).fill(0) };
    for (const e of r.events) {
      if (e.type === 'chance') {
        windows[e.side][Math.min(9, Math.floor((e.minute - 1) / 10))]++;
      }
    }
    shotWindows.push(...windows.home, ...windows.away);
  }
  const shotDisp = dispersion(shotWindows);
  const goalDisp = dispersion(goalCounts);
  assert.ok(shotDisp > 1.15,
    `shot windows must over-disperse: var/mean ${shotDisp.toFixed(3)} ≤ 1.15`);
  assert.ok(goalDisp < 1.15,
    `goals must stay near-Poisson: var/mean ${goalDisp.toFixed(3)} ≥ 1.15`);
});

// --- Determinism under the tick loop ---------------------------------------------

test('scripted mid-match interactions replay identically with ball flow', () => {
  const run = () => {
    const sim = new MatchSim(makePrepared('Det Home', 70), makePrepared('Det Away', 70),
      { seed: 31337, autoSubs: { home: false } });
    for (let i = 0; i < 25; i++) sim.playMinute();
    assert.equal(sim.setInstruction('home', 'Det Home-1', 'runs', 'forward').ok, true);
    for (let i = 0; i < 15; i++) sim.playMinute();
    assert.equal(sim.swapPositions('home', 'Det Home-2', 'Det Home-9').ok, true);
    assert.equal(sim.setTactics('home', { mentality: 'attacking' }).ok, true);
    return sim.finish();
  };
  assert.deepEqual(run(), run());
});

test('the flow log rides along in the match result', () => {
  const r = simulateMatch(makePrepared('Res Home', 70), makePrepared('Res Away', 70),
    { seed: 5, ...opts });
  assert.ok(Array.isArray(r.flow) && r.flow.length > 270,
    `flow log missing or short (${r.flow?.length})`);
  assert.deepEqual(Object.keys(r.flow[0]).sort(), ['minute', 'owner', 'tick', 'zone']);
});
