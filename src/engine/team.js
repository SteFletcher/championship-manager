// Team model: formations, lineup validation, XI selection, derived ratings.
//
// A match lineup is { name, players } where players is exactly 11 entries.
// Squads (see data/teams.js) carry a larger player pool from which an XI
// is selected via selectXI.

import { ability } from './players.js';

export const POSITIONS = ['GK', 'DF', 'MF', 'FW']; // unit families
export const ATTR_MIN = 1;
export const ATTR_MAX = 99;
export const SQUAD_SIZE = 11;
export const MAX_BENCH = 5;

// Detailed pitch positions (EE-2). Every detailed position belongs to a
// unit family; all unit-level engine math reads through UNIT_OF.
export const DETAILED_POSITIONS = ['GK', 'DR', 'DC', 'DL', 'DM', 'MR', 'MC', 'ML', 'AMC', 'ST'];
export const UNIT_OF = {
  GK: 'GK',
  DR: 'DF', DC: 'DF', DL: 'DF',
  DM: 'MF', MR: 'MF', MC: 'MF', ML: 'MF', AMC: 'MF',
  ST: 'FW',
};

// Unit of a slot that may be a detailed position or already a unit
// (legacy lineups and tests still pass unit slots).
export const unitOf = (slot) => UNIT_OF[slot] ?? slot;

// Formations: unit counts (legacy consumers) plus an ordered 11-slot map
// with pitch coordinates. x: 0-100 left→right; y: 0-100 own goal→opponent
// goal. Coordinates are presentation truth for the pitch views (and the
// future match viewer); the simulation does not consume them.
const S = (pos, x, y) => ({ pos, x, y });
export const FORMATIONS = {
  '4-4-2': {
    DF: 4, MF: 4, FW: 2,
    slots: [S('GK', 50, 6),
      S('DR', 12, 32), S('DC', 38, 28), S('DC', 62, 28), S('DL', 88, 32),
      S('MR', 12, 62), S('MC', 38, 58), S('MC', 62, 58), S('ML', 88, 62),
      S('ST', 38, 84), S('ST', 62, 84)],
  },
  '4-3-3': {
    DF: 4, MF: 3, FW: 3,
    slots: [S('GK', 50, 6),
      S('DR', 12, 32), S('DC', 38, 28), S('DC', 62, 28), S('DL', 88, 32),
      S('DM', 50, 48), S('MC', 30, 60), S('MC', 70, 60),
      S('ST', 18, 80), S('ST', 50, 86), S('ST', 82, 80)],
  },
  '4-5-1': {
    DF: 4, MF: 5, FW: 1,
    slots: [S('GK', 50, 6),
      S('DR', 12, 32), S('DC', 38, 28), S('DC', 62, 28), S('DL', 88, 32),
      S('MR', 10, 60), S('MC', 32, 56), S('AMC', 50, 70), S('MC', 68, 56), S('ML', 90, 60),
      S('ST', 50, 86)],
  },
  '3-5-2': {
    DF: 3, MF: 5, FW: 2,
    slots: [S('GK', 50, 6),
      S('DC', 28, 28), S('DC', 50, 26), S('DC', 72, 28),
      S('MR', 8, 60), S('MC', 32, 56), S('DM', 50, 44), S('MC', 68, 56), S('ML', 92, 60),
      S('ST', 38, 84), S('ST', 62, 84)],
  },
  '5-3-2': {
    DF: 5, MF: 3, FW: 2,
    slots: [S('GK', 50, 6),
      S('DR', 8, 34), S('DC', 30, 26), S('DC', 50, 24), S('DC', 70, 26), S('DL', 92, 34),
      S('MC', 32, 58), S('DM', 50, 48), S('MC', 68, 58),
      S('ST', 38, 84), S('ST', 62, 84)],
  },
};

export const MENTALITIES = ['defensive', 'normal', 'attacking'];

// Multiplier on a player's contribution in a slot (EE-2 familiarity
// ladder, replacing the old binary slotPenalty). Players without a
// detailed position (legacy data, plain test XIs) are treated as natural
// anywhere inside their unit — exactly the old behaviour.
export function familiarity(player, slot) {
  const slotUnit = unitOf(slot);
  const playerUnit = player.position ? UNIT_OF[player.position] : player.pos;
  if (player.position && (player.position === slot || playerUnit === slot)) return 1;
  if (player.secondaries?.includes(slot)) return 0.9;
  if (playerUnit === slotUnit) return player.position && DETAILED_POSITIONS.includes(slot) ? 0.8 : 1;
  if (playerUnit === 'GK' || slotUnit === 'GK') return 0.4;
  return 0.65; // cross-unit outfield
}

export function validateTeam(team) {
  const errors = [];
  if (!team || typeof team !== 'object') return ['team is not an object'];
  if (!team.name || typeof team.name !== 'string') errors.push('missing team name');
  if (!Array.isArray(team.players)) return [...errors, 'players is not an array'];

  if (team.players.length !== SQUAD_SIZE) {
    errors.push(`expected ${SQUAD_SIZE} players, got ${team.players.length}`);
  }

  const names = new Set();
  let keepers = 0;
  for (const p of team.players) {
    if (!p.name || typeof p.name !== 'string') {
      errors.push('player missing name');
      continue;
    }
    if (names.has(p.name)) errors.push(`duplicate player name: ${p.name}`);
    names.add(p.name);
    if (!POSITIONS.includes(p.pos)) errors.push(`${p.name}: invalid position ${p.pos}`);
    if (p.pos === 'GK') keepers++;
    for (const attr of ['atk', 'def']) {
      const v = p[attr];
      if (!Number.isFinite(v) || v < ATTR_MIN || v > ATTR_MAX) {
        errors.push(`${p.name}: ${attr} out of range (${v})`);
      }
    }
  }
  if (keepers !== 1) errors.push(`expected exactly 1 GK, got ${keepers}`);
  return errors;
}

// Pick the best available XI (plus bench) from a squad for a formation.
// Deterministic. Players who are injured or suspended are never picked.
// Assignment is per formation slot (EE-2): naturals first, then
// secondaries, with any remaining gaps filled by the best leftover
// weighted by familiarity (the penalty then applies in the match engine).
export function selectXI(squad, formation = '4-4-2', { availableOnly = true } = {}) {
  const shape = FORMATIONS[formation];
  if (!shape) throw new Error(`unknown formation: ${formation}`);

  const pool = squad.filter(
    (p) => !availableOnly || ((p.injuryWeeks ?? 0) === 0 && (p.banMatches ?? 0) === 0)
  );
  const fitness = (p) => ability(p) * (0.6 + 0.4 * ((p.condition ?? 100) / 100));
  const taken = new Set();
  const starters = [];

  // Naturals-first per slot; a leftover pass fills any gaps.
  for (const { pos } of shape.slots) {
    const free = pool.filter((p) => !taken.has(p.id ?? p.name));
    const best = (candidates) =>
      candidates.reduce((a, b) => (fitness(b) > fitness(a) ? b : a), candidates[0]);
    const naturals = free.filter((p) => familiarity(p, pos) === 1 &&
      (pos === 'GK' ? p.pos === 'GK' : p.pos !== 'GK'));
    const secondaries = free.filter((p) => familiarity(p, pos) === 0.9);
    const pick = naturals.length > 0 ? best(naturals)
      : secondaries.length > 0 ? best(secondaries) : null;
    if (pick) taken.add(pick.id ?? pick.name);
    starters.push({ player: pick, slot: pos });
  }

  const leftovers = pool
    .filter((p) => !taken.has(p.id ?? p.name))
    .sort((a, b) => fitness(b) - fitness(a));
  for (const entry of starters) {
    if (entry.player === null) {
      const score = (p) => fitness(p) * familiarity(p, entry.slot);
      const eligible = leftovers.filter((p) =>
        entry.slot === 'GK' ? true : p.pos !== 'GK' || leftovers.every((q) => q.pos === 'GK'));
      if (eligible.length === 0) throw new Error('squad too small to field eleven players');
      const sub = eligible.reduce((a, b) => (score(b) > score(a) ? b : a), eligible[0]);
      leftovers.splice(leftovers.indexOf(sub), 1);
      taken.add(sub.id ?? sub.name);
      entry.player = sub;
    }
  }

  // Bench: best keeper first if one remains, then best outfielders.
  const bench = [];
  const spareGk = leftovers.filter((p) => p.pos === 'GK')[0];
  if (spareGk) bench.push(spareGk);
  for (const p of leftovers) {
    if (bench.length >= MAX_BENCH) break;
    if (!bench.includes(p)) bench.push(p);
  }

  return { starters, bench, formation };
}

function avg(values) {
  if (values.length === 0) return ATTR_MIN;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

// Unit ratings on the 1-99 scale for a plain XI (positions as listed).
export function teamRatings(team) {
  const by = (pos) => team.players.filter((p) => p.pos === pos);
  const gk = by('GK');
  const df = by('DF');
  const mf = by('MF');
  const fw = by('FW');

  // Each unit is led by its specialists with a supporting contribution
  // from midfield, keeping everything on the 1-99 attribute scale.
  return {
    goalkeeping: avg(gk.map((p) => p.def)),
    defense: 0.8 * avg(df.map((p) => p.def)) + 0.2 * avg(mf.map((p) => p.def)),
    midfield: avg(mf.map((p) => (p.atk + p.def) / 2)),
    attack: 0.8 * avg(fw.map((p) => p.atk)) + 0.2 * avg(mf.map((p) => p.atk)),
  };
}

// Single headline rating; accepts a squad (uses its best 4-4-2 XI) or an XI.
export function overallRating(team) {
  if (team.players.length > SQUAD_SIZE) {
    const { starters } = selectXI(team.players, '4-4-2', { availableOnly: false });
    const xi = { name: team.name, players: starters.map((s) => s.player) };
    const r = teamRatings(xi);
    return Math.round((r.goalkeeping + r.defense + r.midfield + r.attack) / 4);
  }
  const r = teamRatings(team);
  return Math.round((r.goalkeeping + r.defense + r.midfield + r.attack) / 4);
}
