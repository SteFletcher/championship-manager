// EE-2 test plan: detailed positions, familiarity ladder, slot-based
// selection, generation balance, and save migration.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  familiarity, selectXI, FORMATIONS, DETAILED_POSITIONS, UNIT_OF, unitOf,
} from '../src/engine/team.js';
import { detailPosition, detailPlayer } from '../src/engine/players.js';
import { simulateMatch } from '../src/engine/match.js';
import { createRng, hashString } from '../src/engine/rng.js';
import { Game } from '../src/engine/game.js';
import { TEAMS } from '../src/data/teams.js';

test('familiarity ladder returns all five grades, monotone', () => {
  const p = { name: 'X', pos: 'MF', position: 'MC', secondaries: ['DM'], atk: 70, def: 70 };
  assert.equal(familiarity(p, 'MC'), 1); // natural
  assert.equal(familiarity(p, 'DM'), 0.9); // secondary
  assert.equal(familiarity(p, 'ML'), 0.8); // same unit family
  assert.equal(familiarity(p, 'ST'), 0.65); // cross-unit outfield
  assert.equal(familiarity(p, 'GK'), 0.4); // GK mismatch
  const grades = ['MC', 'DM', 'ML', 'ST', 'GK'].map((s) => familiarity(p, s));
  for (let i = 1; i < grades.length; i++) {
    assert.ok(grades[i] < grades[i - 1], `ladder not monotone at ${i}`);
  }

  const gk = { name: 'K', pos: 'GK', position: 'GK', secondaries: [] };
  assert.equal(familiarity(gk, 'GK'), 1);
  assert.equal(familiarity(gk, 'DC'), 0.4);
});

test('legacy players without a detailed position keep old slotPenalty behaviour', () => {
  const legacy = { name: 'L', pos: 'MF', atk: 60, def: 60 };
  assert.equal(familiarity(legacy, 'MF'), 1); // unit slot, natural
  assert.equal(familiarity(legacy, 'MC'), 1); // natural anywhere in unit
  assert.equal(familiarity(legacy, 'DF'), 0.65);
  assert.equal(familiarity(legacy, 'GK'), 0.4);
});

test('every detailed position maps to a unit family', () => {
  for (const pos of DETAILED_POSITIONS) {
    assert.ok(['GK', 'DF', 'MF', 'FW'].includes(UNIT_OF[pos]), pos);
  }
  assert.equal(unitOf('AMC'), 'MF');
  assert.equal(unitOf('DF'), 'DF'); // legacy unit slots pass through
});

test('selectXI fills every formation slot in order, deterministically', () => {
  for (const team of TEAMS.slice(0, 6)) {
    for (const [name, shape] of Object.entries(FORMATIONS)) {
      const a = selectXI(team.players, name);
      const b = selectXI(team.players, name);
      assert.equal(a.starters.length, 11);
      assert.deepEqual(
        a.starters.map((s) => s.slot),
        shape.slots.map((s) => s.pos),
        `${team.name} ${name} slot order`
      );
      const ids = new Set(a.starters.map((s) => s.player.id));
      assert.equal(ids.size, 11, `${team.name} ${name} duplicates`);
      assert.deepEqual(a.starters, b.starters, `${team.name} ${name} determinism`);
    }
  }
});

test('selectXI prefers naturals: a full squad starts a natural in every 4-4-2 slot', () => {
  for (const team of TEAMS) {
    const { starters } = selectXI(team.players, '4-4-2');
    for (const { player, slot } of starters) {
      assert.equal(familiarity(player, slot), 1,
        `${team.name}: ${player.name} (${player.position}) at ${slot}`);
    }
  }
});

test('generated players carry valid detailed positions with pos derived', () => {
  for (const team of TEAMS) {
    for (const p of team.players) {
      assert.ok(DETAILED_POSITIONS.includes(p.position), `${p.name}: ${p.position}`);
      assert.equal(p.pos, UNIT_OF[p.position], `${p.name}: pos !== UNIT_OF[position]`);
      assert.ok(Array.isArray(p.secondaries) && p.secondaries.length <= 2);
      for (const s of p.secondaries) {
        assert.ok(DETAILED_POSITIONS.includes(s) && s !== p.position, `${p.name}: ${s}`);
      }
    }
  }
});

test('generation balance: 2 GKs and natural cover for every 4-4-2 slot', () => {
  const needs = {};
  for (const { pos } of FORMATIONS['4-4-2'].slots) needs[pos] = (needs[pos] ?? 0) + 1;
  for (const team of TEAMS) {
    assert.equal(team.players.filter((p) => p.pos === 'GK').length, 2, team.name);
    for (const [pos, count] of Object.entries(needs)) {
      const naturals = team.players.filter((p) => p.position === pos).length;
      assert.ok(naturals >= count, `${team.name}: ${naturals} naturals for ${count}× ${pos}`);
    }
  }
});

test('detailPosition is deterministic and profile-driven', () => {
  assert.equal(detailPosition(createRng(1), 'GK', {}), 'GK');
  assert.equal(detailPosition(createRng(1), 'FW', {}), 'ST');
  assert.equal(detailPosition(createRng(1), 'MF', { atk: 80, def: 40 }), 'AMC');
  assert.equal(detailPosition(createRng(1), 'MF', { atk: 40, def: 80 }), 'DM');
  for (const seed of [1, 2, 3]) {
    assert.equal(
      detailPosition(createRng(seed), 'DF', { atk: 50, def: 50 }),
      detailPosition(createRng(seed), 'DF', { atk: 50, def: 50 })
    );
  }
});

// Strip EE-2 fields and rewind the version to fabricate an old-format save.
function toV6(game) {
  const data = JSON.parse(game.serialize());
  data.version = 6;
  const strip = (p) => { delete p.position; delete p.secondaries; };
  for (const club of data.clubs) club.players.forEach(strip);
  (data.freeAgents ?? []).forEach(strip);
  for (const offer of data.pendingOffers ?? []) if (offer.player) strip(offer.player);
  return JSON.stringify(data);
}

test('v6 save migration is deterministic, idempotent, and playable', () => {
  const game = new Game({ managerName: 'Mig', clubName: 'Bolton Wanderers', seed: 9 });
  for (let w = 0; w < 3; w++) game.advanceWeek(null);
  const v6 = toV6(game);

  const once = Game.restore(v6);
  const twice = Game.restore(Game.restore(v6).serialize());
  const positions = (g) => g.clubs.flatMap((c) => c.players.map(
    (p) => [p.id, p.position, ...(p.secondaries ?? [])].join(':')
  ));
  assert.deepEqual(positions(once), positions(twice));

  for (const club of once.clubs) {
    for (const p of club.players) {
      assert.ok(DETAILED_POSITIONS.includes(p.position), `${p.name}: ${p.position}`);
      assert.equal(p.pos, UNIT_OF[p.position]);
    }
  }

  // The migrated career completes a full match week.
  const results = once.advanceWeek(null);
  assert.ok(results, 'migrated save plays a week');
});

test('detailPlayer fills missing positions and preserves existing ones', () => {
  const fresh = { id: 'x1', name: 'F', pos: 'DF', atk: 40, def: 70 };
  detailPlayer(createRng(hashString('x1:F:pos')), fresh);
  assert.ok(DETAILED_POSITIONS.includes(fresh.position));
  assert.equal(UNIT_OF[fresh.position], 'DF');

  const pinned = { id: 'x2', name: 'P', pos: 'MF', position: 'AMC', atk: 80, def: 30 };
  detailPlayer(createRng(1), pinned);
  assert.equal(pinned.position, 'AMC');
  assert.deepEqual(pinned.secondaries, []);
});

test('statistical: naturals beat the same XI mismatched within-unit', () => {
  // Identical attributes; home plays everyone at his natural slot, away
  // fields the same shape with every outfield detailed position rotated
  // inside its unit (familiarity 0.8) — the ladder must cost goals.
  const slots = FORMATIONS['4-4-2'].slots.map((s) => s.pos);
  const rotate = { DR: 'DL', DC: 'DR', DL: 'DC', MR: 'ML', MC: 'MR', ML: 'MC', ST: 'ST', GK: 'GK' };
  const mkPlayers = (prefix, natural) => slots.map((slot, i) => ({
    id: `${prefix}${i}`,
    name: `${prefix} P${i}`,
    pos: UNIT_OF[slot],
    position: natural ? slot : rotate[slot],
    secondaries: [],
    atk: 70,
    def: 70,
  }));
  const naturalXI = mkPlayers('N', true);
  const shiftedXI = mkPlayers('S', false);
  const setup = (players, name) => ({
    name,
    starters: players.map((p, i) => ({ player: p, slot: slots[i] })),
    formation: '4-4-2',
  });

  let naturalWins = 0;
  let shiftedWins = 0;
  for (let seed = 0; seed < 300; seed++) {
    const r = simulateMatch(setup(naturalXI, 'Naturals'), setup(shiftedXI, 'Shifted'), {
      seed, homeAdvantage: false, timeline: false,
    });
    if (r.winner === 'home') naturalWins++;
    if (r.winner === 'away') shiftedWins++;
  }
  assert.ok(naturalWins > shiftedWins * 1.3,
    `naturals ${naturalWins} vs shifted ${shiftedWins}`);
});
