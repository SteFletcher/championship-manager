// Per-player instructions (EE-4).
//
// Covers the milestone's test plan: defaults are an exact no-op, the two
// axes move play in the promised directions (statistically, over a fixed
// seed set — deterministic, no flake), fatigue costs are modelled,
// instructions persist and remap across formation changes, mid-match
// changes replay deterministically, and AI sides derive presets from
// mentality.

import test from 'node:test';
import assert from 'node:assert/strict';
import { MatchSim, simulateMatch } from '../src/engine/match.js';
import {
  unitOf, FORMATIONS, DEFAULT_INSTRUCTION, IDENTITY_MODS,
  instructionMods, sanitizeInstruction, instructionPreset,
  remapInstructions, defaultInstructions,
} from '../src/engine/team.js';
import { Game } from '../src/engine/game.js';
import { TEAMS } from '../src/data/teams.js';

const clamp = (v) => Math.min(99, Math.max(1, Math.round(v)));

const SLOTS_442 = ['GK', 'DR', 'DC', 'DC', 'DL', 'MR', 'MC', 'MC', 'ML', 'ST', 'ST'];
const FB_IDX = [1, 4]; // DR and DL in SLOTS_442

// A prepared 4-4-2 lineup with detailed slots and deterministic players.
function makePrepared(name, level, { instructions, mentality = 'normal', bench = [] } = {}) {
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
      id: `${name}-${i}`,
      name: `${name} ${slot}${i}`,
      pos: unit,
      atk: clamp(base.atk + wobble),
      def: clamp(base.def + wobble),
    };
  });
  return {
    name,
    shortName: name.slice(0, 3).toUpperCase(),
    starters: players.map((p, i) => ({ player: p, slot: SLOTS_442[i] })),
    bench,
    formation: '4-4-2',
    mentality,
    instructions,
  };
}

function withOverrides(overrides) {
  const instr = defaultInstructions();
  for (const [idx, patch] of Object.entries(overrides)) {
    instr[idx] = { ...instr[idx], ...patch };
  }
  return instr;
}

const outfieldOverride = (patch) =>
  withOverrides(Object.fromEntries(SLOTS_442.map((s, i) => [i, patch]).filter(([i]) => SLOTS_442[i] !== 'GK')));

// --- Modifier table unit tests ----------------------------------------------

test('default instruction yields exact identity modifiers', () => {
  assert.deepEqual(instructionMods({ ...DEFAULT_INSTRUCTION }), { ...IDENTITY_MODS });
  assert.deepEqual(instructionMods(null), IDENTITY_MODS);
});

test('both axes merge; decay multiplies across axes', () => {
  const m = instructionMods({ runs: 'forward', press: 'high' });
  assert.equal(m.atkC, 1.15);
  assert.equal(m.tackleW, 1.4);
  assert.ok(Math.abs(m.decay - 1.15 * 1.10) < 1e-12);
});

test('sanitizeInstruction defaults invalid values and pins keepers', () => {
  assert.deepEqual(sanitizeInstruction({ runs: 'sprint', press: 'high' }, 'MC'),
    { runs: 'balanced', press: 'high' });
  assert.deepEqual(sanitizeInstruction({ runs: 'forward', press: 'high' }, 'GK'),
    { ...DEFAULT_INSTRUCTION });
  assert.deepEqual(sanitizeInstruction(undefined, 'ST'), { ...DEFAULT_INSTRUCTION });
});

// --- Defaults are a no-op ----------------------------------------------------

test('explicit default instructions replay byte-identical to none', () => {
  const run = (instructions) => simulateMatch(
    makePrepared('Noop Home', 72, { instructions }),
    makePrepared('Noop Away', 68),
    { seed: 555, timeline: false }
  );
  assert.deepEqual(run(defaultInstructions()), run(undefined));
});

test('explicit defaults are a no-op for full-squad setups too', () => {
  const base = { seed: 4321, timeline: false };
  const plain = simulateMatch(TEAMS[2], TEAMS[3], base);
  const explicit = simulateMatch(
    { ...TEAMS[2], instructions: defaultInstructions() },
    { ...TEAMS[3], instructions: defaultInstructions() },
    base
  );
  assert.deepEqual(explicit, plain);
});

// --- Statistical direction tests (fixed seed set, paired control) -----------

const SIMS = 500;

function runBatch(instructions) {
  const t = { fb: 0, scored: 0, conceded: 0, oppPasses: 0, tackles: 0, fouls: 0, cards: 0 };
  for (let i = 0; i < SIMS; i++) {
    const r = simulateMatch(
      makePrepared('Instr Home', 70, { instructions }),
      makePrepared('Instr Away', 70),
      { seed: 3000 + i, timeline: false, autoSubs: { home: false, away: false } }
    );
    t.scored += r.score.home;
    t.conceded += r.score.away;
    t.tackles += r.playerStats.home.reduce((s, l) => s + l.tackles, 0);
    t.oppPasses += r.playerStats.away.reduce((s, l) => s + l.passes, 0);
    t.fouls += r.stats.home.fouls;
    t.cards += r.stats.home.yellowCards + r.stats.home.redCards;
    for (const idx of FB_IDX) {
      const line = r.playerStats.home.find((l) => l.id === `Instr Home-${idx}`);
      t.fb += line.shots + line.assists;
    }
  }
  return t;
}

const control = runBatch(undefined);

test('forward runs: full-backs attack more and the team concedes more', () => {
  const treated = runBatch(withOverrides({ 1: { runs: 'forward' }, 4: { runs: 'forward' } }));
  assert.ok(treated.fb >= control.fb * 1.4,
    `full-back shots+assists ${treated.fb} < 1.4 × control ${control.fb}`);
  assert.ok(treated.conceded > control.conceded,
    `conceded ${treated.conceded} not above control ${control.conceded}`);
});

test('hold protects: an all-hold XI concedes fewer and scores fewer', () => {
  const treated = runBatch(outfieldOverride({ runs: 'hold' }));
  assert.ok(treated.conceded < control.conceded,
    `conceded ${treated.conceded} not below control ${control.conceded}`);
  assert.ok(treated.scored < control.scored,
    `scored ${treated.scored} not below control ${control.scored}`);
});

test('high press trades fouls for turnovers', () => {
  const treated = runBatch(outfieldOverride({ press: 'high' }));
  assert.ok(treated.oppPasses < control.oppPasses,
    `opponent passes ${treated.oppPasses} not below control ${control.oppPasses}`);
  assert.ok(treated.tackles > control.tackles,
    `tackles ${treated.tackles} not above control ${control.tackles}`);
  assert.ok(treated.fouls + treated.cards > control.fouls + control.cards,
    `fouls+cards ${treated.fouls + treated.cards} not above control ${control.fouls + control.cards}`);
});

// --- Fatigue ------------------------------------------------------------------

test('forward runs + high press cost condition by the modelled margin', () => {
  const conditionOf = (instructions) => {
    const r = simulateMatch(
      makePrepared('Tired Home', 70, { instructions }),
      makePrepared('Tired Away', 70),
      { seed: 42, timeline: false, autoSubs: { home: false, away: false } }
    );
    const line = r.playerStats.home.find((l) => l.id === 'Tired Home-6');
    assert.equal(line.minutes, r.playedMinutes, 'player must finish the match');
    return line.condition;
  };
  const rested = conditionOf(undefined);
  const worked = conditionOf(withOverrides({ 6: { runs: 'forward', press: 'high' } }));
  assert.ok(rested - worked > 4,
    `condition gap ${(rested - worked).toFixed(1)} ≤ 4 (rested ${rested.toFixed(1)}, worked ${worked.toFixed(1)})`);
});

// --- Mid-match API ------------------------------------------------------------

test('setInstruction validates axis, value, side, player, and keeper', () => {
  const sim = new MatchSim(makePrepared('Val Home', 70), makePrepared('Val Away', 70), { seed: 7 });
  assert.equal(sim.setInstruction('nowhere', 'Val Home-1', 'runs', 'forward').ok, false);
  assert.equal(sim.setInstruction('home', 'Val Home-1', 'sprint', 'forward').ok, false);
  assert.equal(sim.setInstruction('home', 'Val Home-1', 'runs', 'sprint').ok, false);
  assert.equal(sim.setInstruction('home', 'not-on-pitch', 'runs', 'forward').ok, false);
  assert.match(sim.setInstruction('home', 'Val Home-0', 'runs', 'forward').error, /keeper/);
  const ok = sim.setInstruction('home', 'Val Home-1', 'runs', 'forward');
  assert.deepEqual(ok, { ok: true, changed: true });
  const again = sim.setInstruction('home', 'Val Home-1', 'runs', 'forward');
  assert.deepEqual(again, { ok: true, changed: false });
  const evt = sim.events.find((e) => e.type === 'instruction');
  assert.ok(evt, 'instruction change must log an event');
  assert.deepEqual(evt.data, { playerId: 'Val Home-1', axis: 'runs', value: 'forward' });
});

test('a scripted mid-match instruction change replays identically', () => {
  const run = () => {
    const sim = new MatchSim(
      makePrepared('Rep Home', 70), makePrepared('Rep Away', 70),
      { seed: 99, autoSubs: { home: false } }
    );
    for (let i = 0; i < 30; i++) sim.playMinute();
    assert.equal(sim.setInstruction('home', 'Rep Home-1', 'runs', 'forward').ok, true);
    assert.equal(sim.setInstruction('home', 'Rep Home-8', 'press', 'deep').ok, true);
    return sim.finish();
  };
  assert.deepEqual(run(), run());
});

test('substitute inherits the shirt instructions', () => {
  const bench = [{ id: 'Sub-DF', name: 'Sub DF', pos: 'DF', atk: 40, def: 66 }];
  const sim = new MatchSim(
    makePrepared('Sub Home', 70, { bench }), makePrepared('Sub Away', 70),
    { seed: 11, autoSubs: { home: false } }
  );
  sim.playMinute();
  assert.equal(sim.setInstruction('home', 'Sub Home-1', 'runs', 'forward').ok, true);
  assert.equal(sim.makeSub('home', 'Sub Home-1', 'Sub-DF').ok, true);
  const entry = sim.sides.home.onPitch.find((e) => (e.player.id ?? e.player.name) === 'Sub-DF');
  assert.equal(entry.instr.runs, 'forward');
  assert.equal(entry.mods.atkC, 1.15);
});

test('in-match formation change keeps same-slot instructions, resets the rest', () => {
  const sim = new MatchSim(
    makePrepared('Swap Home', 70), makePrepared('Swap Away', 70),
    { seed: 13, autoSubs: { home: false } }
  );
  sim.playMinute();
  assert.equal(sim.setInstruction('home', 'Swap Home-1', 'runs', 'forward').ok, true); // DR
  assert.equal(sim.setInstruction('home', 'Swap Home-8', 'runs', 'hold').ok, true); // ML
  const before = new Map(sim.sides.home.onPitch.map((e) => [e.player.id, e.slot]));
  assert.equal(sim.setTactics('home', { formation: '5-3-2' }).ok, true);
  for (const e of sim.sides.home.onPitch) {
    if (e.slot === before.get(e.player.id)) continue;
    assert.deepEqual(e.instr, { ...DEFAULT_INSTRUCTION },
      `${e.player.id} moved ${before.get(e.player.id)}→${e.slot} but kept instructions`);
  }
  const dr = sim.sides.home.onPitch.find((e) => e.slot === 'DR');
  if (dr && dr.player.id === 'Swap Home-1') {
    assert.equal(dr.instr.runs, 'forward', 'DR kept its slot so it keeps its instruction');
  }
  // 5-3-2 has no ML: the hold instruction must not survive anywhere.
  assert.ok(!sim.sides.home.onPitch.some((e) => e.instr.runs === 'hold'),
    'orphaned ML instruction must reset');
});

// --- AI presets ---------------------------------------------------------------

test('instructionPreset derives slot instructions from mentality', () => {
  assert.deepEqual(instructionPreset('attacking', 'DR'), { runs: 'forward', press: 'high' });
  assert.deepEqual(instructionPreset('attacking', 'MC'), { runs: 'balanced', press: 'high' });
  assert.deepEqual(instructionPreset('defensive', 'DL'), { runs: 'hold', press: 'deep' });
  assert.deepEqual(instructionPreset('defensive', 'ST'), { runs: 'balanced', press: 'deep' });
  assert.deepEqual(instructionPreset('attacking', 'GK'), { ...DEFAULT_INSTRUCTION });
  assert.deepEqual(instructionPreset('normal', 'MC'), { ...DEFAULT_INSTRUCTION });
});

test('a trailing AI side applies the attacking preset to its full-backs', () => {
  for (let seed = 1; seed <= 30; seed++) {
    const sim = new MatchSim(
      makePrepared('Big Home', 84), makePrepared('Small Away', 58),
      { seed, timeline: false }
    );
    sim.simulateToEnd();
    if (sim.sides.away.setup.mentality !== 'attacking') continue;
    const fullBacks = sim.sides.away.onPitch.filter((e) => e.slot === 'DR' || e.slot === 'DL');
    if (fullBacks.length === 0) continue;
    for (const fb of fullBacks) {
      assert.equal(fb.instr.runs, 'forward');
      assert.equal(fb.instr.press, 'high');
    }
    return;
  }
  assert.fail('no seed in 1..30 produced a trailing AI side with full-backs — widen the search');
});

// --- Persistence & remap --------------------------------------------------------

test('remapInstructions carries same-position slots and resets orphans', () => {
  const instr = withOverrides({
    1: { runs: 'forward', press: 'high' }, // DR
    6: { runs: 'forward' },                // first MC
    8: { runs: 'hold', press: 'deep' },    // ML
  });
  const remapped = remapInstructions('4-4-2', instr, '5-3-2');
  const slots532 = FORMATIONS['5-3-2'].slots.map((s) => s.pos);
  assert.deepEqual(remapped[slots532.indexOf('DR')], { runs: 'forward', press: 'high' });
  assert.deepEqual(remapped[slots532.indexOf('MC')], { runs: 'forward', press: 'normal' });
  assert.ok(!remapped.some((x) => x.runs === 'hold'), 'ML orphan resets — 5-3-2 has no ML');
  assert.deepEqual(remapped[0], { ...DEFAULT_INSTRUCTION });
  assert.equal(remapped.length, 11);
});

test('game tactics: setSlotInstruction validates and persists via save/load', () => {
  const g = new Game({ managerName: 'Boss', clubName: TEAMS[0].name, seed: 1 });
  assert.equal(g.version, 9);
  assert.deepEqual(g.tactics.instructions, defaultInstructions());
  assert.throws(() => g.setSlotInstruction(0, 'runs', 'forward'), /keeper/);
  assert.throws(() => g.setSlotInstruction(99, 'runs', 'forward'), /slot index/);
  assert.throws(() => g.setSlotInstruction(1, 'runs', 'sprint'), /invalid instruction/);
  g.setSlotInstruction(1, 'runs', 'forward');
  g.setSlotInstruction(1, 'press', 'high');
  const restored = Game.restore(g.serialize());
  assert.deepEqual(restored.tactics.instructions[1], { runs: 'forward', press: 'high' });
});

test('game formation change remaps saved instructions', () => {
  const g = new Game({ managerName: 'Boss', clubName: TEAMS[0].name, seed: 2 });
  g.setSlotInstruction(1, 'runs', 'forward'); // DR in 4-4-2
  g.setSlotInstruction(8, 'runs', 'hold');    // ML in 4-4-2
  g.setTactics({ formation: '5-3-2' });
  const slots = FORMATIONS['5-3-2'].slots.map((s) => s.pos);
  assert.equal(g.tactics.instructions[slots.indexOf('DR')].runs, 'forward');
  assert.ok(!g.tactics.instructions.some((x) => x.runs === 'hold'));
});

test('v8 saves migrate to v9 with default instructions', () => {
  const g = new Game({ managerName: 'Boss', clubName: TEAMS[0].name, seed: 3 });
  const data = JSON.parse(g.serialize());
  data.version = 8;
  delete data.tactics.instructions;
  const restored = Game.restore(JSON.stringify(data));
  assert.equal(restored.version, 9);
  assert.deepEqual(restored.tactics.instructions, defaultInstructions());
});
