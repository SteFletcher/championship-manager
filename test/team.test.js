import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateTeam,
  teamRatings,
  overallRating,
  selectXI,
  FORMATIONS,
  SQUAD_SIZE,
  ATTR_MIN,
  ATTR_MAX,
} from '../src/engine/team.js';
import { TEAMS, getTeam } from '../src/data/teams.js';

export function makeUniformTeam(name, level) {
  const positions = ['GK', 'DF', 'DF', 'DF', 'DF', 'MF', 'MF', 'MF', 'MF', 'FW', 'FW'];
  return {
    name,
    players: positions.map((pos, i) => ({
      name: `${name} Player ${i + 1}`,
      pos,
      atk: level,
      def: level,
    })),
  };
}

test('a well-formed team validates cleanly', () => {
  assert.deepEqual(validateTeam(makeUniformTeam('Testers', 70)), []);
});

test('validation rejects malformed input', () => {
  assert.ok(validateTeam(null).length > 0);
  assert.ok(validateTeam({}).length > 0);
  assert.ok(validateTeam({ name: 'X', players: 'nope' }).length > 0);
});

test('validation catches wrong squad size', () => {
  const team = makeUniformTeam('Short Squad', 70);
  team.players.pop();
  assert.ok(validateTeam(team).some((e) => e.includes('11 players')));
});

test('validation requires exactly one goalkeeper', () => {
  const none = makeUniformTeam('No Keeper', 70);
  none.players[0].pos = 'DF';
  assert.ok(validateTeam(none).some((e) => e.includes('GK')));

  const two = makeUniformTeam('Two Keepers', 70);
  two.players[1].pos = 'GK';
  assert.ok(validateTeam(two).some((e) => e.includes('GK')));
});

test('validation catches out-of-range attributes', () => {
  const team = makeUniformTeam('Cheaters', 70);
  team.players[5].atk = 150;
  assert.ok(validateTeam(team).some((e) => e.includes('out of range')));

  const team2 = makeUniformTeam('Zeroes', 70);
  team2.players[5].def = 0;
  assert.ok(validateTeam(team2).some((e) => e.includes('out of range')));
});

test('validation catches invalid positions and duplicate names', () => {
  const badPos = makeUniformTeam('Bad Pos', 70);
  badPos.players[10].pos = 'STRIKER';
  assert.ok(validateTeam(badPos).some((e) => e.includes('invalid position')));

  const dupes = makeUniformTeam('Dupes', 70);
  dupes.players[3].name = dupes.players[2].name;
  assert.ok(validateTeam(dupes).some((e) => e.includes('duplicate')));
});

test('uniform team has ratings equal to its level', () => {
  const r = teamRatings(makeUniformTeam('Uniform', 70));
  for (const unit of ['goalkeeping', 'defense', 'midfield', 'attack']) {
    assert.ok(Math.abs(r[unit] - 70) < 0.001, `${unit} = ${r[unit]}`);
  }
  assert.equal(overallRating(makeUniformTeam('Uniform', 70)), 70);
});

test('stronger players produce strictly higher ratings', () => {
  const strong = teamRatings(makeUniformTeam('Strong', 90));
  const weak = teamRatings(makeUniformTeam('Weak', 50));
  for (const unit of ['goalkeeping', 'defense', 'midfield', 'attack']) {
    assert.ok(strong[unit] > weak[unit]);
  }
});

test('all bundled clubs carry valid 18-player squads', () => {
  assert.ok(TEAMS.length >= 8, 'need a reasonable league size');
  for (const team of TEAMS) {
    assert.equal(team.players.length, 18, `${team.name} squad size`);
    const ids = new Set(team.players.map((p) => p.id));
    assert.equal(ids.size, 18, `${team.name} has duplicate player ids`);
    assert.equal(team.players.filter((p) => p.pos === 'GK').length, 2);
    assert.ok(team.capacity > 0 && team.balance > 0 && team.transferBudget > 0);
    for (const p of team.players) {
      assert.ok(p.atk >= ATTR_MIN && p.atk <= ATTR_MAX);
      assert.ok(p.def >= ATTR_MIN && p.def <= ATTR_MAX);
      assert.ok(p.age >= 16 && p.age <= 35, `${p.name} age ${p.age}`);
      assert.ok(p.wage > 0 && p.value > 0);
      assert.ok(p.contractYears >= 1 && p.contractYears <= 4);
      assert.ok(p.consistency >= 1 && p.consistency <= 99);
      assert.ok(p.injuryProne >= 1 && p.injuryProne <= 99);
    }
    // A valid XI must be selectable in every formation.
    for (const formation of Object.keys(FORMATIONS)) {
      const { starters, bench } = selectXI(team.players, formation);
      const xi = { name: team.name, players: starters.map((s) => s.player) };
      assert.equal(starters.length, SQUAD_SIZE);
      assert.ok(bench.length >= 3, `${team.name} bench too small`);
      assert.equal(starters.filter((s) => s.slot === 'GK').length, 1);
      const errors = validateTeam(xi).filter((e) => !e.includes('exactly 1 GK'));
      assert.deepEqual(errors, [], `${team.name} ${formation}`);
    }
  }
});

test('bundled squads are deterministic across module loads', async () => {
  const fresh = await import('../src/data/teams.js?cachebust=1');
  assert.deepEqual(fresh.TEAMS, TEAMS);
});

test('club tiers are reflected in overall ratings', () => {
  const best = overallRating(getTeam('Manchester United'));
  const worst = overallRating(getTeam('Luton Town'));
  assert.ok(best > worst + 10, `best ${best} vs worst ${worst}`);
});

test('getTeam finds clubs by name', () => {
  assert.equal(getTeam('Manchester United').shortName, 'MUN');
  assert.equal(getTeam('Nonexistent FC'), undefined);
});
