// Mid-match position swaps (12 · Match Tactics re-design, DRG-05).
//
// swapPositions exchanges two on-pitch players between their slots.
// Instructions belong to the slot (the EE-4 shirt rule), the keeper is
// protected, and the call draws no RNG so scripted swaps replay
// byte-identically.

import test from 'node:test';
import assert from 'node:assert/strict';
import { MatchSim } from '../src/engine/match.js';
import { unitOf, DEFAULT_INSTRUCTION } from '../src/engine/team.js';

const clamp = (v) => Math.min(99, Math.max(1, Math.round(v)));

const SLOTS_442 = ['GK', 'DR', 'DC', 'DC', 'DL', 'MR', 'MC', 'MC', 'ML', 'ST', 'ST'];

function makePrepared(name, level, { instructions } = {}) {
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
    bench: [],
    formation: '4-4-2',
    mentality: 'normal',
    instructions,
  };
}

function sim(opts = {}) {
  return new MatchSim(
    makePrepared('Swap Home', 70, opts), makePrepared('Swap Away', 70),
    { seed: opts.seed ?? 21, autoSubs: { home: false, away: false } }
  );
}

test('swapPositions exchanges slots and slot instructions', () => {
  const instructions = SLOTS_442.map((s, i) =>
    i === 1 ? { runs: 'forward', press: 'high' } : { ...DEFAULT_INSTRUCTION });
  const s = sim({ instructions });
  s.playMinute();
  const res = s.swapPositions('home', 'Swap Home-1', 'Swap Home-8'); // DR ↔ ML
  assert.deepEqual(res, { ok: true });

  const byId = (id) => s.sides.home.onPitch.find((e) => e.player.id === id);
  const a = byId('Swap Home-1');
  const b = byId('Swap Home-8');
  assert.equal(a.slot, 'ML');
  assert.equal(b.slot, 'DR');
  // The forward/high instruction stayed on the DR slot: B now carries it.
  assert.deepEqual(b.instr, { runs: 'forward', press: 'high' });
  assert.deepEqual(a.instr, { ...DEFAULT_INSTRUCTION });
  assert.equal(b.mods.atkC, 1.15);
  assert.equal(a.mods.atkC, 1);
  // Stat lines follow.
  assert.equal(s.sides.home.lines.get('Swap Home-1').slot, 'ML');
  assert.equal(s.sides.home.lines.get('Swap Home-8').slot, 'DR');
  // Slot counts are unchanged — it is the same set of slots.
  assert.deepEqual(s.sides.home.slotCounts, { GK: 1, DF: 4, MF: 4, FW: 2 });

  const evt = s.events.find((e) => e.type === 'position');
  assert.ok(evt, 'swap must log a position event');
  assert.deepEqual(evt.data,
    { aId: 'Swap Home-1', bId: 'Swap Home-8', aSlot: 'ML', bSlot: 'DR' });
});

test('swapPositions validates side, players, keeper, and match state', () => {
  const s = sim();
  s.playMinute();
  assert.equal(s.swapPositions('nowhere', 'Swap Home-1', 'Swap Home-2').ok, false);
  assert.equal(s.swapPositions('home', 'Swap Home-1', 'Swap Home-1').ok, false);
  assert.equal(s.swapPositions('home', 'Swap Home-1', 'ghost').ok, false);
  assert.match(s.swapPositions('home', 'Swap Home-0', 'Swap Home-1').error, /keeper/);
  assert.match(s.swapPositions('home', 'Swap Home-1', 'Swap Home-0').error, /keeper/);
  s.simulateToEnd();
  assert.match(s.swapPositions('home', 'Swap Home-1', 'Swap Home-2').error, /over/);
});

test('a scripted mid-match swap replays byte-identically', () => {
  const run = () => {
    const s = sim({ seed: 77 });
    for (let i = 0; i < 40; i++) s.playMinute();
    assert.equal(s.swapPositions('home', 'Swap Home-2', 'Swap Home-10').ok, true);
    return s.finish();
  };
  assert.deepEqual(run(), run());
});

test('a swap draws no RNG: the pre-swap prefix is untouched', () => {
  const play = (withSwap) => {
    const s = sim({ seed: 33 });
    for (let i = 0; i < 40; i++) s.playMinute();
    const prefix = s.events.length;
    if (withSwap) s.swapPositions('home', 'Swap Home-5', 'Swap Home-9');
    s.playMinute();
    return { s, prefix };
  };
  const a = play(false);
  const b = play(true);
  // Identical up to the swap; the position event is purely additive there.
  assert.deepEqual(
    b.s.events.slice(0, b.prefix),
    a.s.events.slice(0, a.prefix)
  );
});

test('swapping across units moves the men, not the shape', () => {
  const s = sim({ seed: 5 });
  s.playMinute();
  // Put the best DC up front and the ST at centre-back.
  assert.equal(s.swapPositions('home', 'Swap Home-2', 'Swap Home-9').ok, true);
  const dc = s.sides.home.onPitch.find((e) => e.player.id === 'Swap Home-2');
  const st = s.sides.home.onPitch.find((e) => e.player.id === 'Swap Home-9');
  assert.equal(dc.slot, 'ST');
  assert.equal(st.slot, 'DC');
  // Still a valid 4-4-2: one keeper, same unit headcounts.
  const units = s.sides.home.onPitch.map((e) => unitOf(e.slot)).sort().join(',');
  assert.equal(units, ['DF', 'DF', 'DF', 'DF', 'FW', 'FW', 'GK', 'MF', 'MF', 'MF', 'MF'].sort().join(','));
});
