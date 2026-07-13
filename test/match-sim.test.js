import test from 'node:test';
import assert from 'node:assert/strict';
import { MatchSim, simulateMatch } from '../src/engine/match.js';
import { unitOf } from '../src/engine/team.js';
import { TEAMS } from '../src/data/teams.js';
import { makeUniformTeam } from './team.test.js';

const evenA = makeUniformTeam('Even A', 72);
const evenB = makeUniformTeam('Even B', 72);

function withBench(team, level = 68) {
  const bench = [
    { id: `${team.name}-b0`, name: `${team.name} Sub GK`, pos: 'GK', atk: 30, def: level },
    { id: `${team.name}-b1`, name: `${team.name} Sub DF`, pos: 'DF', atk: 40, def: level },
    { id: `${team.name}-b2`, name: `${team.name} Sub MF`, pos: 'MF', atk: level, def: level },
    { id: `${team.name}-b3`, name: `${team.name} Sub FW`, pos: 'FW', atk: level, def: 40 },
  ];
  return { ...team, bench };
}

test('stepping minute by minute equals one-shot simulation', () => {
  const sim = new MatchSim(evenA, evenB, { seed: 99 });
  while (!sim.finished) sim.playMinute();
  const stepped = sim.finish();
  const oneShot = simulateMatch(evenA, evenB, { seed: 99 });
  assert.deepEqual(stepped, oneShot);
});

test('a full squad input auto-selects an XI and bench', () => {
  const r = simulateMatch(TEAMS[0], TEAMS[1], { seed: 5, timeline: false });
  for (const sideKey of ['home', 'away']) {
    const lines = r.playerStats[sideKey];
    assert.equal(lines.filter((l) => l.started).length, 11);
    assert.ok(lines.length > 11, 'bench should be present');
  }
});

test('manual substitution swaps players and is capped at three', () => {
  const home = withBench(evenA);
  const sim = new MatchSim(home, evenB, { seed: 42, autoSubs: { home: false, away: false } });
  for (let i = 0; i < 30; i++) sim.playMinute();

  const starterId = evenA.players[10].name; // a FW (no id, so name is the id)
  const res = sim.makeSub('home', starterId, `${evenA.name}-b3`);
  assert.equal(res.ok, true);

  // The player who came off must accrue nothing further.
  const offMinutes = sim.sides.home.lines.get(starterId).minutes;
  for (let i = 0; i < 30; i++) sim.playMinute();
  assert.equal(sim.sides.home.lines.get(starterId).minutes, offMinutes);
  assert.ok(sim.sides.home.lines.get(`${evenA.name}-b3`).minutes > 0);

  // Invalid subs are rejected cleanly.
  assert.equal(sim.makeSub('home', starterId, `${evenA.name}-b2`).ok, false); // off pitch
  assert.equal(sim.makeSub('home', evenA.players[9].name, 'nope').ok, false); // not on bench

  // Cap at three.
  assert.equal(sim.makeSub('home', evenA.players[9].name, `${evenA.name}-b2`).ok, true);
  assert.equal(sim.makeSub('home', evenA.players[8].name, `${evenA.name}-b1`).ok, true);
  const fourth = sim.makeSub('home', evenA.players[7].name, `${evenA.name}-b0`);
  assert.equal(fourth.ok, false);

  sim.finish();
});

test('injuries occur, are reported with a duration, and force substitutions', () => {
  let injuries = 0;
  let forcedSubs = 0;
  for (let seed = 0; seed < 400 && injuries < 20; seed++) {
    const r = simulateMatch(withBench(evenA), withBench(evenB), { seed, timeline: false });
    for (const injury of r.injuries) {
      injuries++;
      assert.ok(injury.weeks >= 1 && injury.weeks <= 16, `weeks ${injury.weeks}`);
      assert.ok(injury.minute >= 1 && injury.minute <= r.playedMinutes);
      // The injured player never plays another minute after the injury.
      const line = r.playerStats[injury.side].find((l) => l.id === injury.id);
      assert.ok(line.minutes <= injury.minute, 'played on after injury');
      // A sub event should follow in the same minute when subs were available.
      if (r.events.some((e) => e.type === 'sub' && e.minute === injury.minute)) forcedSubs++;
    }
  }
  assert.ok(injuries >= 20, `only ${injuries} injuries in 400 matches`);
  assert.ok(forcedSubs > injuries * 0.6, `forced subs rare: ${forcedSubs}/${injuries}`);
});

test('user-managed sides are left short after injury until the manager subs', () => {
  let checked = 0;
  for (let seed = 0; seed < 500 && checked < 10; seed++) {
    const sim = new MatchSim(withBench(evenA), withBench(evenB), {
      seed, autoSubs: { home: false },
    });
    while (!sim.finished) {
      const events = sim.playMinute();
      const injury = events.find((e) => e.type === 'injury' && e.side === 'home');
      if (injury) {
        checked++;
        // No automatic replacement for the user side: down to fewer men,
        // and no sub event was emitted this minute.
        assert.ok(sim.sides.home.onPitch.length < 11, 'side not reduced');
        // No bench player comes on automatically. (An emergency keeper
        // reassignment is allowed — someone must go in goal.)
        assert.ok(
          !events.some((e) => e.type === 'sub' && e.side === 'home' &&
            !e.text.includes('emergency')),
          `seed ${seed}: auto-sub happened for user side`);
        // The manager can now bring someone on manually.
        const on = sim.sides.home.benchLeft[0];
        const off = sim.sides.home.onPitch[5];
        if (on && off) {
          const before = sim.sides.home.onPitch.length;
          assert.equal(sim.makeSub('home', off.player.id ?? off.player.name, on.id ?? on.name).ok, true);
          assert.equal(sim.sides.home.onPitch.length, before);
        }
        break;
      }
    }
    sim.finish();
  }
  assert.ok(checked >= 10, `only ${checked} user-side injuries observed`);
});

test('AI auto-subs happen and never exceed the limit', () => {
  let subs = 0;
  for (let seed = 0; seed < 100; seed++) {
    const r = simulateMatch(TEAMS[2], TEAMS[3], { seed, timeline: false });
    assert.ok(r.subsUsed.home <= 3 && r.subsUsed.away <= 3);
    subs += r.subsUsed.home + r.subsUsed.away;
  }
  assert.ok(subs > 30, `AI never rotates: ${subs} subs in 100 matches`);
});

test('knockout ties always produce a winner, via extra time and penalties', () => {
  let extraTimes = 0;
  let shootouts = 0;
  for (let seed = 0; seed < 300; seed++) {
    const r = simulateMatch(evenA, evenB, { seed, knockout: true, timeline: false });
    assert.notEqual(r.winner, 'draw', `seed ${seed}: knockout tie drawn`);
    if (r.events.some((e) => e.type === 'extra-time')) {
      extraTimes++;
      assert.ok(r.playedMinutes > 115, `seed ${seed}: ET too short (${r.playedMinutes})`);
    }
    if (r.shootout) {
      shootouts++;
      assert.notEqual(r.shootout.home, r.shootout.away, 'shootout tied');
      const winnerByPens = r.shootout.home > r.shootout.away ? 'home' : 'away';
      assert.equal(r.score.home, r.score.away, 'shootout despite a decided match');
      assert.equal(r.winner, winnerByPens);
      // Penalty events are recorded and consistent with the tally.
      const scoredEvents = r.events.filter((e) => e.type === 'penalty-scored');
      assert.equal(scoredEvents.length, r.shootout.home + r.shootout.away);
    }
  }
  assert.ok(extraTimes > 20, `extra time too rare: ${extraTimes}/300`);
  assert.ok(shootouts > 5, `shootouts too rare: ${shootouts}/300`);
  assert.ok(shootouts < extraTimes, 'every ET going to pens is suspicious');
});

test('league matches never go to extra time', () => {
  for (let seed = 0; seed < 100; seed++) {
    const r = simulateMatch(evenA, evenB, { seed, timeline: false });
    assert.ok(r.playedMinutes <= 95);
    assert.equal(r.shootout, null);
    assert.ok(!r.events.some((e) => e.type === 'extra-time'));
  }
});

test('mentality matters: attacking sides create more, concede more', () => {
  const N = 600;
  let attackGoals = 0;
  let attackConceded = 0;
  let normalGoals = 0;
  let normalConceded = 0;
  const opts = { homeAdvantage: false, timeline: false, autoSubs: { home: false, away: false } };
  for (let seed = 0; seed < N; seed++) {
    const atk = simulateMatch({ ...evenA, mentality: 'attacking' }, evenB, { seed, ...opts });
    attackGoals += atk.score.home;
    attackConceded += atk.score.away;
    const norm = simulateMatch(evenA, evenB, { seed, ...opts });
    normalGoals += norm.score.home;
    normalConceded += norm.score.away;
  }
  assert.ok(attackGoals > normalGoals * 1.03, `${attackGoals} vs ${normalGoals}`);
  assert.ok(attackConceded > normalConceded * 1.02, `${attackConceded} vs ${normalConceded}`);
});

// A full 18-player squad of identical players, so formation comparisons
// measure structure, not squad depth.
function makeUniformSquad(name, level) {
  const shape = [['GK', 2], ['DF', 6], ['MF', 6], ['FW', 4]];
  const players = [];
  let i = 0;
  for (const [pos, count] of shape) {
    for (let j = 0; j < count; j++) {
      players.push({
        id: `${name}-${i}`, name: `${name} Player ${i++}`, pos,
        atk: level, def: level,
      });
    }
  }
  return { name, players };
}

test('formations change the shape of play', () => {
  const N = 1500;
  const squad = makeUniformSquad('Shape FC', 72);
  const opp = makeUniformSquad('Opp FC', 72);
  // AI tactical reactions off, so the formation under test stays fixed.
  const opts = { homeAdvantage: false, timeline: false, autoSubs: { home: false, away: false } };
  const totals = {};
  for (const f of ['4-3-3', '4-5-1', '5-3-2']) {
    totals[f] = { gf: 0, ga: 0, poss: 0 };
    for (let seed = 0; seed < N; seed++) {
      const r = simulateMatch({ ...squad, formation: f }, opp, { seed, ...opts });
      totals[f].gf += r.score.home;
      totals[f].ga += r.score.away;
      totals[f].poss += r.stats.home.possession;
    }
  }
  // Extreme-vs-extreme comparisons keep the margins statistically solid.
  assert.ok(totals['4-3-3'].gf > totals['4-5-1'].gf * 1.05,
    `three forwards should outscore one: ${totals['4-3-3'].gf} vs ${totals['4-5-1'].gf}`);
  assert.ok(totals['5-3-2'].ga < totals['4-3-3'].ga * 0.97,
    `five defenders should concede less: ${totals['5-3-2'].ga} vs ${totals['4-3-3'].ga}`);
  assert.ok(totals['4-5-1'].poss > totals['4-3-3'].poss,
    `a packed midfield should hold more of the ball: ${totals['4-5-1'].poss} vs ${totals['4-3-3'].poss}`);
});

test('condition drains during a match and tired players are weaker', () => {
  const r = simulateMatch(evenA, evenB, { seed: 3 });
  for (const sideKey of ['home', 'away']) {
    for (const line of r.playerStats[sideKey]) {
      if (line.minutes >= 90) {
        // Keepers barely exert themselves; outfielders tire properly.
        const cap = line.slot === 'GK' ? 96 : 85;
        assert.ok(line.condition < cap, `${line.name} finished on ${line.condition}`);
        assert.ok(line.condition >= 20);
      }
    }
  }
  // Tired teams (low starting condition) lose to fresh ones over many sims.
  const tired = {
    ...evenA,
    players: evenA.players.map((p) => ({ ...p, condition: 55 })),
  };
  let freshWins = 0;
  let tiredWins = 0;
  for (let seed = 0; seed < 400; seed++) {
    const res = simulateMatch(tired, evenB, { seed, homeAdvantage: false, timeline: false });
    if (res.winner === 'home') tiredWins++;
    if (res.winner === 'away') freshWins++;
  }
  assert.ok(freshWins > tiredWins * 1.2, `fresh ${freshWins} vs tired ${tiredWins}`);
});

test('players out of position contribute less', () => {
  // An XI of natural players vs the same attributes all out of position.
  const natural = makeUniformTeam('Natural', 75);
  const scrambled = {
    name: 'Scrambled',
    players: makeUniformTeam('Scrambled', 75).players.map((p, i) => ({
      ...p,
      // Rotate outfield positions so everyone plays out of position.
      pos: p.pos === 'GK' ? 'GK' : p.pos === 'DF' ? 'MF' : p.pos === 'MF' ? 'FW' : 'DF',
    })),
  };
  // Force the scrambled XI into the natural shape via explicit slots.
  const scrambledSetup = {
    name: 'Scrambled',
    starters: scrambled.players.map((p, i) => ({
      player: p,
      slot: natural.players[i].pos,
    })),
  };
  let naturalWins = 0;
  let scrambledWins = 0;
  for (let seed = 0; seed < 300; seed++) {
    const r = simulateMatch(natural, scrambledSetup, {
      seed, homeAdvantage: false, timeline: false,
    });
    if (r.winner === 'home') naturalWins++;
    if (r.winner === 'away') scrambledWins++;
  }
  assert.ok(naturalWins > scrambledWins * 1.5,
    `natural ${naturalWins} vs scrambled ${scrambledWins}`);
});

test('setTactics changes mentality and formation mid-match with a clean remap', () => {
  const sim = new MatchSim(evenA, evenB, { seed: 7, autoSubs: { home: false, away: false } });
  for (let i = 0; i < 20; i++) sim.playMinute();

  // Invalid inputs are rejected.
  assert.equal(sim.setTactics('home', { formation: '9-0-1' }).ok, false);
  assert.equal(sim.setTactics('home', { mentality: 'suicidal' }).ok, false);
  assert.equal(sim.setTactics('nobody', {}).ok, false);

  const res = sim.setTactics('home', { formation: '5-3-2', mentality: 'defensive' });
  assert.equal(res.ok, true);
  assert.equal(res.changed, true);
  assert.equal(sim.sides.home.setup.formation, '5-3-2');
  assert.equal(sim.sides.home.setup.mentality, 'defensive');

  // Shape is exactly 1 GK / 5 DF / 3 MF / 2 FW with no player lost or duplicated.
  // On-pitch slots are detailed positions (EE-2); count by unit family.
  const slots = { GK: 0, DF: 0, MF: 0, FW: 0 };
  const ids = new Set();
  for (const e of sim.sides.home.onPitch) {
    slots[unitOf(e.slot)]++;
    ids.add(e.player.name);
  }
  assert.deepEqual(slots, { GK: 1, DF: 5, MF: 3, FW: 2 });
  assert.equal(ids.size, 11);
  assert.deepEqual(sim.sides.home.slotCounts, { GK: 1, DF: 5, MF: 3, FW: 2 });

  // A tactics event was logged for the commentary feed.
  const last = sim.events[sim.events.length - 1];
  assert.equal(last.type, 'tactics');
  assert.match(last.text, /5-3-2 \(defensive\)/);

  // No-op change reports changed: false and logs nothing new.
  const count = sim.events.length;
  const noop = sim.setTactics('home', { formation: '5-3-2', mentality: 'defensive' });
  assert.equal(noop.changed, false);
  assert.equal(sim.events.length, count);
  sim.finish();
});

test('formation change with ten men leaves the deficit up front', () => {
  let checked = 0;
  for (let seed = 0; seed < 400 && checked < 8; seed++) {
    const sim = new MatchSim(evenA, evenB, { seed, autoSubs: { home: false, away: false } });
    while (!sim.finished && sim.sides.home.onPitch.length === 11) sim.playMinute();
    if (sim.finished) continue;
    checked++;
    sim.setTactics('home', { formation: '4-4-2' });
    const slots = { GK: 0, DF: 0, MF: 0, FW: 0 };
    for (const e of sim.sides.home.onPitch) slots[e.slot]++;
    const total = slots.GK + slots.DF + slots.MF + slots.FW;
    assert.equal(total, sim.sides.home.onPitch.length);
    assert.ok(slots.DF >= 4 - (11 - total), 'defence should be filled first');
    assert.ok(slots.FW <= 2, 'deficit should land up front');
    sim.finish();
  }
  assert.ok(checked >= 8, `only ${checked} short-handed matches found`);
});

test('switching to attacking mid-match lifts goals scored after the switch', () => {
  const N = 800;
  let switchedGoals = 0;
  let baselineGoals = 0;
  for (let seed = 0; seed < N; seed++) {
    const run = (attack) => {
      const sim = new MatchSim(evenA, evenB, {
        seed, homeAdvantage: false, timeline: false,
        autoSubs: { home: false, away: false },
      });
      for (let i = 0; i < 45; i++) sim.playMinute();
      const at45 = sim.score.home;
      if (attack) sim.setTactics('home', { mentality: 'attacking' });
      sim.simulateToEnd();
      return sim.score.home - at45; // second-half goals only
    };
    switchedGoals += run(true);
    baselineGoals += run(false);
  }
  assert.ok(switchedGoals > baselineGoals * 1.02,
    `attacking switch had no effect: ${switchedGoals} vs ${baselineGoals}`);
});

test('AI managers react: losing sides go attacking, leading sides shut up shop', () => {
  let chasedWhenLosing = 0;
  let protectedWhenLeading = 0;
  let losingSamples = 0;
  let leadingSamples = 0;
  for (let seed = 0; seed < 300; seed++) {
    const sim = new MatchSim(evenA, evenB, { seed, timeline: false });
    const r = sim.finish();
    const margin = r.score.home - r.score.away;
    if (margin < 0) {
      losingSamples++;
      if (sim.sides.home.setup.mentality === 'attacking') chasedWhenLosing++;
    } else if (margin > 0) {
      leadingSamples++;
      if (sim.sides.home.setup.mentality === 'defensive') protectedWhenLeading++;
    }
    // Tactics events show up in the log when switches happen.
    if (sim.sides.home.setup.mentality !== 'normal') {
      assert.ok(r.events.some((e) => e.type === 'tactics' && e.side === 'home'),
        `seed ${seed}: mentality changed without a tactics event`);
    }
  }
  assert.ok(losingSamples > 50 && leadingSamples > 50, 'not enough samples');
  assert.ok(chasedWhenLosing / losingSamples > 0.5,
    `losing AI rarely chases: ${chasedWhenLosing}/${losingSamples}`);
  assert.ok(protectedWhenLeading / leadingSamples > 0.4,
    `leading AI rarely protects: ${protectedWhenLeading}/${leadingSamples}`);
});

test('user-managed sides never have their tactics changed by the AI', () => {
  for (let seed = 0; seed < 60; seed++) {
    const sim = new MatchSim(evenA, evenB, { seed, autoSubs: { home: false } });
    const r = sim.finish();
    assert.equal(sim.sides.home.setup.mentality, 'normal', `seed ${seed}`);
    assert.ok(!r.events.some((e) => e.type === 'tactics' && e.side === 'home'));
  }
});

test('determinism holds for the resumable sim with all features', () => {
  const a = simulateMatch(withBench(evenA), withBench(evenB), { seed: 12345, knockout: true });
  const b = simulateMatch(withBench(evenA), withBench(evenB), { seed: 12345, knockout: true });
  assert.deepEqual(a, b);
});
