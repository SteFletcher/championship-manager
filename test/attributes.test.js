// EE-3 test plan: attribute schema, archetypes, composites, migration,
// and proof the engine actually consults the new attributes.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OUTFIELD_ATTRS, GK_ATTRS, ALL_ATTRS, atkOf, defOf, recomputeComposites,
  attrOf, unitContribution, expandAttributes, developPlayer, ability,
} from '../src/engine/players.js';
import { MatchSim, simulateMatch } from '../src/engine/match.js';
import { FORMATIONS, UNIT_OF } from '../src/engine/team.js';
import { createRng, hashString } from '../src/engine/rng.js';
import { Game } from '../src/engine/game.js';
import { TEAMS } from '../src/data/teams.js';

const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;

test('every generated player carries all eight attributes in range', () => {
  for (const team of TEAMS) {
    for (const p of team.players) {
      for (const a of ALL_ATTRS) {
        assert.ok(Number.isInteger(p[a]) && p[a] >= 1 && p[a] <= 99,
          `${p.name} ${a} = ${p[a]}`);
      }
      if (p.pos !== 'GK') {
        assert.ok(p.handling <= 15 && p.reflexes <= 15,
          `${p.name} (${p.pos}) has keeper hands: ${p.handling}/${p.reflexes}`);
      }
      assert.equal(p.atk, atkOf(p), `${p.name} atk not the derived blend`);
      assert.equal(p.def, defOf(p), `${p.name} def not the derived blend`);
    }
  }
});

test('archetypes hold: STs finish, defenders tackle, GKs handle', () => {
  const byPosition = (pos) => TEAMS.flatMap((t) => t.players.filter((p) => p.position === pos));
  const sts = byPosition('ST');
  const dcs = byPosition('DC');
  const gks = byPosition('GK');
  assert.ok(mean(sts.map((p) => p.finishing)) > mean(sts.map((p) => p.tackling)) + 25,
    'ST finishing should dwarf ST tackling');
  assert.ok(mean(dcs.map((p) => p.tackling)) > mean(dcs.map((p) => p.finishing)) + 25,
    'DC tackling should dwarf DC finishing');
  // Squads carry no natural DMs (EE-2 templates), so exercise the DM
  // archetype directly through the solver.
  const dm = { id: 'dm1', name: 'Solver DM', pos: 'MF', position: 'DM', atk: 55, def: 75 };
  expandAttributes(createRng(1), dm);
  assert.ok(dm.tackling > dm.finishing + 25,
    `DM tackling ${dm.tackling} should dwarf finishing ${dm.finishing}`);
  // Positioning and stamina are legitimately decent for keepers; the
  // ball-playing attributes must sit well below the gloves.
  for (const gk of gks) {
    const ballMax = Math.max(gk.passing, gk.finishing, gk.tackling, gk.pace);
    assert.ok((gk.handling + gk.reflexes) / 2 > ballMax,
      `${gk.name}: keeper attrs should lead the profile`);
  }
  assert.ok(mean(gks.map((p) => p.handling)) > 60 && mean(gks.map((p) => p.reflexes)) > 60,
    'GK handling/reflexes should average high');
});

test('write-through: mutating an attribute moves the composites', () => {
  // Any forward with headroom in finishing will do.
  const p = structuredClone(TEAMS.flatMap((t) => t.players)
    .find((q) => q.pos === 'FW' && q.finishing <= 75));
  const before = p.atk;
  p.finishing = Math.min(99, p.finishing + 20);
  recomputeComposites(p);
  assert.ok(p.atk > before, 'atk should rise with finishing');
  assert.equal(p.atk, atkOf(p));
});

test('attrOf falls back to the legacy engine formulas for plain players', () => {
  const legacy = { pos: 'MF', atk: 70, def: 50 };
  assert.equal(attrOf(legacy, 'passing'), 60); // (atk+def)/2 — old pass skill
  assert.equal(attrOf(legacy, 'finishing'), 70); // atk — old shot input
  assert.equal(attrOf(legacy, 'tackling'), 50); // def — old tackle input
  assert.equal(attrOf(legacy, 'stamina'), 49.5); // decay factor exactly 1
  assert.equal(unitContribution(legacy, 'MF'), 60);
  assert.equal(unitContribution({ pos: 'DF', atk: 30, def: 80 }, 'DF'), 80);
  assert.equal(unitContribution({ pos: 'GK', atk: 10, def: 85 }, 'GK'), 85);
});

test('expansion round-trips composites within ±2 and is idempotent', () => {
  const rng = createRng(hashString('roundtrip'));
  for (const team of TEAMS.slice(0, 8)) {
    for (const p of team.players) {
      const bare = {
        id: p.id, name: p.name, pos: p.pos, position: p.position,
        atk: p.atk, def: p.def,
      };
      const seed = createRng(hashString(`${bare.id}:x`));
      expandAttributes(seed, bare);
      assert.ok(Math.abs(bare.atk - p.atk) <= 2, `${p.name} atk ${p.atk} → ${bare.atk}`);
      assert.ok(Math.abs(bare.def - p.def) <= 2, `${p.name} def ${p.def} → ${bare.def}`);
      const again = structuredClone(bare);
      expandAttributes(rng, again); // has attributes: must be untouched
      assert.deepEqual(again, bare);
    }
  }
});

// Fabricate a pre-EE-3 (v7) save from a current one.
function toV7(game) {
  const data = JSON.parse(game.serialize());
  data.version = 7;
  const strip = (p) => { for (const a of ALL_ATTRS) delete p[a]; };
  for (const club of data.clubs) club.players.forEach(strip);
  (data.freeAgents ?? []).forEach(strip);
  for (const offer of data.pendingOffers ?? []) if (offer.player) strip(offer.player);
  return JSON.stringify(data);
}

test('v7 migration: deterministic, ±2 composites, <5% valuation shift, playable', () => {
  const game = new Game({ managerName: 'Mig', clubName: 'Bolton Wanderers', seed: 11 });
  for (let w = 0; w < 2; w++) game.advanceWeek(null);
  const abilityBefore = mean(game.clubs.flatMap((c) => c.players.map(ability)));
  const v7 = toV7(game);

  const once = Game.restore(v7);
  const twice = Game.restore(v7);
  const attrs = (g) => g.clubs.flatMap((c) => c.players.map(
    (p) => ALL_ATTRS.map((a) => p[a]).join(':')
  ));
  assert.deepEqual(attrs(once), attrs(twice), 'migration not deterministic');

  const originals = new Map(game.clubs.flatMap((c) => c.players.map(
    (p) => [p.id, p]
  )));
  for (const club of once.clubs) {
    for (const p of club.players) {
      const orig = originals.get(p.id);
      assert.ok(Math.abs(p.atk - orig.atk) <= 2, `${p.name} atk drifted`);
      assert.ok(Math.abs(p.def - orig.def) <= 2, `${p.name} def drifted`);
    }
  }
  const abilityAfter = mean(once.clubs.flatMap((c) => c.players.map(ability)));
  assert.ok(Math.abs(abilityAfter - abilityBefore) / abilityBefore < 0.05,
    `mean ability shifted ${abilityBefore} → ${abilityAfter}`);

  assert.ok(once.advanceWeek(null), 'migrated save plays a week');
});

test('development moves attributes, not composites; physique fades first', () => {
  const rng = createRng(3);
  const veteran = structuredClone(TEAMS[0].players[5]);
  veteran.age = 31; // will become 32: decline branch
  const paceBefore = veteran.pace;
  const posnBefore = veteran.positioning;
  let paceDrop = 0;
  let posnDrop = 0;
  for (let i = 0; i < 40; i++) {
    const v = structuredClone(veteran);
    developPlayer(createRng(i), v);
    paceDrop += paceBefore - v.pace;
    posnDrop += posnBefore - v.positioning;
    assert.equal(v.atk, atkOf(v), 'composites must stay derived');
    assert.equal(v.def, defOf(v));
  }
  assert.ok(paceDrop > posnDrop, `pace should fade faster (pace ${paceDrop} vs posn ${posnDrop})`);
});

// --- Statistical proof the engine consults the new attributes -------------

const slots442 = FORMATIONS['4-4-2'].slots.map((s) => s.pos);

function attrXI(prefix, tweak = () => ({})) {
  return slots442.map((slot, i) => {
    const gk = slot === 'GK';
    const base = {
      id: `${prefix}${i}`, name: `${prefix} P${i}`,
      pos: UNIT_OF[slot], position: slot, secondaries: [],
      passing: 60, finishing: 60, tackling: 60, positioning: 60, pace: 60, stamina: 60,
      handling: gk ? 70 : 8, reflexes: gk ? 70 : 8,
    };
    Object.assign(base, tweak(slot, i));
    return recomputeComposites(base);
  });
}

function setup(players, name) {
  return {
    name,
    starters: players.map((p, i) => ({ player: p, slot: slots442[i] })),
    formation: '4-4-2',
  };
}

function series(home, away, n = 300) {
  let homeGoals = 0;
  let awayGoals = 0;
  let homeWins = 0;
  let awayWins = 0;
  for (let seed = 0; seed < n; seed++) {
    const r = simulateMatch(home, away, { seed, homeAdvantage: false, timeline: false });
    homeGoals += r.score.home;
    awayGoals += r.score.away;
    if (r.winner === 'home') homeWins++;
    if (r.winner === 'away') awayWins++;
  }
  return { homeGoals, awayGoals, homeWins, awayWins };
}

test('statistical: finishing wins games at equal composites', () => {
  // Both sides have identical composite totals; home trades tackling for
  // finishing in its forwards. Sharper finishing must out-score.
  const finishers = attrXI('F', (slot) =>
    UNIT_OF[slot] === 'FW' ? { finishing: 75, tackling: 45 } : {});
  const control = attrXI('C', (slot) =>
    UNIT_OF[slot] === 'FW' ? { finishing: 60, tackling: 60 } : {});
  const r = series(setup(finishers, 'Finishers'), setup(control, 'Control'));
  assert.ok(r.homeGoals > r.awayGoals * 1.1,
    `finishers ${r.homeGoals} goals vs control ${r.awayGoals}`);
});

test('statistical: keeper handling/reflexes stop goals', () => {
  const wall = attrXI('W', (slot) => (slot === 'GK' ? { handling: 85, reflexes: 85 } : {}));
  const control = attrXI('K');
  // Both keepers face the same balanced attack (the control XI mirrored).
  const attackers = attrXI('A');
  const vsWall = series(setup(attackers, 'Att'), setup(wall, 'Wall'));
  const vsControl = series(setup(attackers, 'Att'), setup(control, 'Ctl'));
  assert.ok(vsWall.homeGoals < vsControl.homeGoals * 0.9,
    `wall conceded ${vsWall.homeGoals} vs control ${vsControl.homeGoals}`);
});

test('stamina shapes fatigue: 90 vs 40 stamina gap > 8 points at minute 90', () => {
  const strong = attrXI('S', () => ({ stamina: 90 }));
  const weak = attrXI('Q', () => ({ stamina: 40 }));
  const sim = new MatchSim(setup(strong, 'Strong'), setup(weak, 'Weak'), {
    seed: 1, autoSubs: { home: false, away: false }, timeline: false,
  });
  for (let i = 0; i < 90; i++) sim.playMinute();
  const cond = (sideKey, id) => sim.sides[sideKey].lines.get(id).condition;
  // Compare outfielders that stayed on for the full 90.
  const stayedOn = (sideKey) => sim.sides[sideKey].onPitch
    .filter((e) => e.slot !== 'GK')
    .map((e) => cond(sideKey, e.player.id));
  const gap = mean(stayedOn('home')) - mean(stayedOn('away'));
  assert.ok(gap > 8, `condition gap ${gap.toFixed(1)}`);
});
