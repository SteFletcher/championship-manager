// Team model: formations, lineup validation, XI selection, derived ratings.
//
// A match lineup is { name, players } where players is exactly 11 entries.
// Squads (see data/teams.js) carry a larger player pool from which an XI
// is selected via selectXI.

import { ability } from './players.js';

export const POSITIONS = ['GK', 'DF', 'MF', 'FW'];
export const ATTR_MIN = 1;
export const ATTR_MAX = 99;
export const SQUAD_SIZE = 11;
export const MAX_BENCH = 5;

export const FORMATIONS = {
  '4-4-2': { DF: 4, MF: 4, FW: 2 },
  '4-3-3': { DF: 4, MF: 3, FW: 3 },
  '4-5-1': { DF: 4, MF: 5, FW: 1 },
  '3-5-2': { DF: 3, MF: 5, FW: 2 },
  '5-3-2': { DF: 5, MF: 3, FW: 2 },
};

export const MENTALITIES = ['defensive', 'normal', 'attacking'];

// Multiplier on a player's contribution when played out of position.
export function slotPenalty(player, slot) {
  if (player.pos === slot) return 1;
  if (player.pos === 'GK' || slot === 'GK') return 0.5;
  return 0.75;
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
// If a unit lacks natural players, the best leftover fills in out of
// position (with the slot penalty applying in the match engine).
export function selectXI(squad, formation = '4-4-2', { availableOnly = true } = {}) {
  const shape = FORMATIONS[formation];
  if (!shape) throw new Error(`unknown formation: ${formation}`);

  const pool = squad.filter(
    (p) => !availableOnly || ((p.injuryWeeks ?? 0) === 0 && (p.banMatches ?? 0) === 0)
  );
  const fitness = (p) => ability(p) * (0.6 + 0.4 * ((p.condition ?? 100) / 100));
  const taken = new Set();
  const starters = [];

  const fillSlots = (slot, count) => {
    const natural = pool
      .filter((p) => p.pos === slot && !taken.has(p.id ?? p.name))
      .sort((a, b) => fitness(b) - fitness(a));
    for (let i = 0; i < count; i++) {
      const pick = natural[i];
      if (pick) {
        taken.add(pick.id ?? pick.name);
        starters.push({ player: pick, slot });
      } else {
        starters.push({ player: null, slot }); // fill from leftovers below
      }
    }
  };

  fillSlots('GK', 1);
  for (const unit of ['DF', 'MF', 'FW']) fillSlots(unit, shape[unit]);

  const leftovers = pool
    .filter((p) => !taken.has(p.id ?? p.name))
    .sort((a, b) => fitness(b) - fitness(a));
  for (const entry of starters) {
    if (entry.player === null) {
      const idx = leftovers.findIndex((p) =>
        entry.slot === 'GK' ? true : p.pos !== 'GK' || leftovers.every((q) => q.pos === 'GK')
      );
      const sub = idx >= 0 ? leftovers.splice(idx, 1)[0] : null;
      if (!sub) throw new Error('squad too small to field eleven players');
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
