// Player model: creation, valuation, and season-to-season development.
//
// A full player record is:
//   { id, name, pos, atk, def, age,
//     consistency, injuryProne,            // hidden attributes, 1-99
//     wage, value, contractYears,
//     condition, form, morale,             // live state, managed by game layer
//     injuryWeeks, banMatches, yellowsAccum }

export const PEAK_AGE_MIN = 24;
export const PEAK_AGE_MAX = 28;
export const RETIREMENT_AGE = 34;

// Ability is the headline number used for valuation and AI decisions.
export function ability(player) {
  if (player.pos === 'GK') return player.def;
  if (player.pos === 'DF') return player.def * 0.8 + player.atk * 0.2;
  if (player.pos === 'FW') return player.atk * 0.8 + player.def * 0.2;
  return (player.atk + player.def) / 2;
}

export function ageFactor(age) {
  if (age <= 20) return 0.75;
  if (age < PEAK_AGE_MIN) return 0.9;
  if (age <= PEAK_AGE_MAX) return 1;
  return Math.max(0.25, 1 - (age - PEAK_AGE_MAX) * 0.13);
}

// Weekly wage in pounds, CM-era scale.
export function fairWage(player) {
  const ab = ability(player);
  return Math.round(((ab / 10) ** 3.1 * 14) / 10) * 10;
}

// Transfer value in pounds.
export function fairValue(player) {
  const ab = ability(player);
  const raw = (ab / 10) ** 4.3 * 850 * ageFactor(player.age);
  return Math.max(10000, Math.round(raw / 5000) * 5000);
}

// --- Detailed positions (EE-2) ---------------------------------------------
//
// A player's `position` is a detailed pitch position (see DETAILED_POSITIONS
// in team.js); `pos` remains the derived unit family so every unit-level
// consumer keeps working. Detailing draws from its own seeded RNG streams,
// never the main game/squad streams, so adding it disturbs nothing.

const UNIT_POSITIONS = {
  GK: ['GK'],
  DF: ['DR', 'DC', 'DL'],
  MF: ['DM', 'MR', 'MC', 'ML', 'AMC'],
  FW: ['ST'],
};

// A plausible neighbour for each position, used for secondary positions.
const ADJACENT = {
  DR: ['DC', 'MR'], DC: ['DM', 'DR'], DL: ['DC', 'ML'],
  DM: ['DC', 'MC'], MR: ['MC', 'DR'], MC: ['DM', 'AMC'], ML: ['MC', 'DL'],
  AMC: ['MC', 'ST'], ST: ['AMC'],
};

// Derive a detailed position from a unit position and attribute profile.
// DF: centre-backs twice as common as full-backs. MF: strongly attacking
// profiles become AMC, strongly defensive ones DM, the rest spread wide
// and central. Deterministic given the rng.
export function detailPosition(rng, pos, { atk = 50, def = 50 } = {}) {
  if (pos === 'GK') return 'GK';
  if (pos === 'FW') return 'ST';
  if (pos === 'DF') {
    return rng.weightedPick([
      { item: 'DC', weight: 2 }, { item: 'DR', weight: 1 }, { item: 'DL', weight: 1 },
    ]);
  }
  if (atk - def > 12) return 'AMC';
  if (def - atk > 12) return 'DM';
  return rng.weightedPick([
    { item: 'MC', weight: 2 }, { item: 'MR', weight: 1 }, { item: 'ML', weight: 1 },
  ]);
}

export function maybeSecondary(rng, position) {
  if (position === 'GK' || !rng.chance(0.35)) return [];
  const options = ADJACENT[position] ?? [];
  return options.length > 0 ? [rng.pick(options)] : [];
}

// Ensure a player carries position/secondaries, deriving them when absent.
// Used by squad generation, save migration, and youth intake.
export function detailPlayer(rng, player) {
  if (!player.position) {
    player.position = detailPosition(rng, player.pos, player);
    player.secondaries = maybeSecondary(rng, player.position);
  } else {
    player.secondaries ??= [];
  }
  return player;
}

// Assign detailed positions across a whole squad. Within each unit the
// first-choice players follow a fixed template that guarantees every
// 4-4-2 slot has a natural (POS-06); depth players are detailed by
// profile. Players that already carry a detailed position keep it.
const UNIT_TEMPLATES = {
  GK: ['GK', 'GK'],
  DF: ['DR', 'DC', 'DC', 'DL'],
  MF: ['MR', 'MC', 'MC', 'ML'],
  FW: ['ST', 'ST'],
};

export function assignDetailedPositions(rng, players) {
  for (const unit of Object.keys(UNIT_POSITIONS)) {
    const template = [...UNIT_TEMPLATES[unit]];
    for (const p of players.filter((q) => q.pos === unit)) {
      if (p.position) {
        p.secondaries ??= [];
        continue;
      }
      p.position = template.shift() ?? detailPosition(rng, p.pos, p);
      p.secondaries = maybeSecondary(rng, p.position);
    }
  }
  return players;
}

// --- Attribute expansion (EE-3) ---------------------------------------------
//
// Eight real attributes drive the match engine; atk/def survive as derived
// composites (ATTR-02 blends) so valuation, UI tables, scouting, and any
// unconverted path keep working. Composites are stored as plain fields and
// recomputed on any attribute write (players stay plain JSON).

export const OUTFIELD_ATTRS = ['passing', 'finishing', 'tackling', 'positioning', 'pace', 'stamina'];
export const GK_ATTRS = ['handling', 'reflexes'];
export const ALL_ATTRS = [...OUTFIELD_ATTRS, ...GK_ATTRS];

const clampAttr = (v) => Math.min(99, Math.max(1, v));

export function hasAttributes(p) {
  return Number.isFinite(p.finishing);
}

export function atkOf(p) {
  if (!hasAttributes(p)) return p.atk;
  return clampAttr(Math.round(
    0.35 * p.finishing + 0.30 * p.passing + 0.20 * p.pace + 0.15 * p.positioning
  ));
}

export function defOf(p) {
  if (!hasAttributes(p)) return p.def;
  if (p.pos === 'GK') return clampAttr(Math.round(0.5 * p.handling + 0.5 * p.reflexes));
  return clampAttr(Math.round(
    0.40 * p.tackling + 0.35 * p.positioning + 0.25 * p.pace
  ));
}

// Write-through: the single place composites are recomputed from attributes.
export function recomputeComposites(p) {
  p.atk = atkOf(p);
  p.def = defOf(p);
  return p;
}

// Attribute read with legacy fallbacks that reproduce the pre-EE-3 engine
// formulas exactly, so plain {atk, def} players (old fixtures, test XIs)
// behave as they always did at every decision point.
export function attrOf(p, name) {
  const v = p[name];
  if (Number.isFinite(v)) return v;
  switch (name) {
    case 'finishing': return p.atk;
    case 'tackling': return p.def;
    case 'handling':
    case 'reflexes': return p.def;
    case 'stamina': return 49.5; // 1.30 − 49.5/165 = 1: legacy decay unchanged
    default: return (p.atk + p.def) / 2; // passing, positioning, pace
  }
}

// What a player brings to each unit's collective strength (§4.3 row 5).
// Legacy players reproduce the old per-unit composite reads exactly.
export function unitContribution(p, unit) {
  if (!hasAttributes(p)) {
    if (unit === 'GK' || unit === 'DF') return p.def;
    if (unit === 'FW') return p.atk;
    return (p.atk + p.def) / 2;
  }
  if (unit === 'GK') return 0.5 * p.handling + 0.5 * p.reflexes;
  if (unit === 'DF') return 0.6 * p.tackling + 0.4 * p.positioning;
  if (unit === 'FW') return 0.6 * p.finishing + 0.4 * p.pace;
  // MF: passing-led blend.
  return 0.5 * p.passing + 0.2 * p.positioning + 0.15 * p.tackling + 0.15 * p.pace;
}

// Position archetypes (§4.2): offsets around the player's base level.
// high ≈ +10, mid ≈ 0, low ≈ −15; '±' attrs get extra spread via jitter.
const ARCHETYPES = {
  GK: { passing: -15, finishing: -15, tackling: -15, positioning: 10, pace: -15, stamina: 0 },
  DC: { passing: 0, finishing: -15, tackling: 10, positioning: 10, pace: -15, stamina: 0 },
  DR: { passing: 0, finishing: -15, tackling: 10, positioning: 0, pace: 10, stamina: 0 },
  DL: { passing: 0, finishing: -15, tackling: 10, positioning: 0, pace: 10, stamina: 0 },
  DM: { passing: 10, finishing: -15, tackling: 10, positioning: 10, pace: -15, stamina: 0 },
  MC: { passing: 10, finishing: -15, tackling: 0, positioning: 0, pace: 0, stamina: 10 },
  MR: { passing: 10, finishing: 0, tackling: -15, positioning: 0, pace: 10, stamina: 0 },
  ML: { passing: 10, finishing: 0, tackling: -15, positioning: 0, pace: 10, stamina: 0 },
  AMC: { passing: 10, finishing: 10, tackling: -15, positioning: 0, pace: 0, stamina: 0 },
  ST: { passing: -15, finishing: 10, tackling: -15, positioning: 0, pace: 10, stamina: 0 },
};

const atkBlend = (v) =>
  0.35 * v.finishing + 0.30 * v.passing + 0.20 * v.pace + 0.15 * v.positioning;
const defBlend = (v) =>
  0.40 * v.tackling + 0.35 * v.positioning + 0.25 * v.pace;

// Expand a player's atk/def into the eight attributes: archetype profile
// first, then an iterative solve pulling the ATTR-02 blends onto the
// original composites (±2 round-trip for feasible targets, which covers
// all generated data). Deterministic given the rng. Idempotent: players
// that already carry attributes are left untouched.
export function expandAttributes(rng, p) {
  if (hasAttributes(p)) return p;
  const offsets = ARCHETYPES[p.position ?? (p.pos === 'GK' ? 'GK' : 'MC')] ?? ARCHETYPES.MC;
  const base = (p.atk + p.def) / 2;
  const v = {};
  for (const a of OUTFIELD_ATTRS) v[a] = clampAttr(base + offsets[a] + rng.int(-6, 6));

  if (p.pos === 'GK') {
    // def is carried entirely by handling/reflexes; the outfield attrs
    // only need to satisfy the (low) atk blend. The spread is bounded so
    // neither attribute clips, keeping the mean (and def) exact.
    const bound = Math.min(5, 99 - p.def, p.def - 1);
    const spread = Math.max(-bound, Math.min(bound, rng.int(-5, 5)));
    p.handling = clampAttr(Math.round(p.def + spread));
    p.reflexes = clampAttr(Math.round(2 * p.def - p.handling));
    for (let i = 0; i < 12; i++) {
      const eA = p.atk - atkBlend(v);
      if (Math.abs(eA) <= 1) break;
      for (const a of ['finishing', 'passing', 'pace', 'positioning']) {
        v[a] = clampAttr(v[a] + eA * 0.5);
      }
    }
  } else {
    p.handling = rng.int(1, 15);
    p.reflexes = rng.int(1, 15);
    for (let i = 0; i < 16; i++) {
      const eA = p.atk - atkBlend(v);
      const eD = p.def - defBlend(v);
      if (Math.abs(eA) <= 1 && Math.abs(eD) <= 1) break;
      v.finishing = clampAttr(v.finishing + eA * 0.7);
      v.passing = clampAttr(v.passing + eA * 0.7);
      v.tackling = clampAttr(v.tackling + eD * 1.1);
      const eShared = (eA + eD) / 2;
      v.pace = clampAttr(v.pace + eShared * 0.35);
      v.positioning = clampAttr(v.positioning + eShared * 0.35);
    }
  }
  for (const a of OUTFIELD_ATTRS) p[a] = clampAttr(Math.round(v[a]));
  return recomputeComposites(p);
}

export function createPlayer(rng, { id, name, pos, position, atk, def, age }) {
  const player = {
    id,
    name,
    pos,
    ...(position ? { position, secondaries: [] } : {}),
    atk,
    def,
    age,
    consistency: rng.int(30, 95),
    injuryProne: rng.int(10, 90),
    contractYears: rng.int(1, 4),
    condition: 100,
    form: 6.0,
    morale: 70,
    injuryWeeks: 0,
    banMatches: 0,
    yellowsAccum: 0,
  };
  player.wage = fairWage(player);
  player.value = fairValue(player);
  return player;
}

export function isAvailable(player) {
  return player.injuryWeeks === 0 && player.banMatches === 0;
}

// End-of-season development: youngsters improve, veterans decline.
// With EE-3 attributes, individual attributes move — pace and stamina
// decline first with age, positioning keeps growing latest — and the
// composites are recomputed through the write-through helper. Legacy
// players without attributes keep the old composite path.
// Mutates the player; returns true if the player retires.
const PHYSICAL_ATTRS = ['pace', 'stamina'];

export function developPlayer(rng, player) {
  player.age++;
  if (hasAttributes(player)) {
    const move = (attrs, amount) => {
      for (const a of attrs) {
        const delta = amount > 0 ? rng.int(0, amount) : -rng.int(0, -amount);
        player[a] = clampAttr(player[a] + delta);
      }
    };
    const technicals = OUTFIELD_ATTRS.filter((a) => !PHYSICAL_ATTRS.includes(a) && a !== 'positioning');
    const gk = player.pos === 'GK' ? GK_ATTRS : [];
    if (player.age <= 21) move([...technicals, ...PHYSICAL_ATTRS, ...gk, 'positioning'], 4);
    else if (player.age < PEAK_AGE_MIN) move([...technicals, ...PHYSICAL_ATTRS, ...gk, 'positioning'], 2);
    else if (player.age > 31) {
      move(PHYSICAL_ATTRS, -5);
      move([...technicals, ...gk], -3);
      move(['positioning'], -1);
    } else if (player.age > PEAK_AGE_MAX) {
      move(PHYSICAL_ATTRS, -3);
      move([...technicals, ...gk], -1);
      move(['positioning'], 1); // reading of the game grows latest
    } else {
      move(['positioning'], 1);
    }
    recomputeComposites(player);
  } else {
    const grow = (amount) => {
      player.atk = Math.min(99, player.atk + rng.int(0, amount));
      player.def = Math.min(99, player.def + rng.int(0, amount));
    };
    const fade = (amount) => {
      player.atk = Math.max(1, player.atk - rng.int(0, amount));
      player.def = Math.max(1, player.def - rng.int(0, amount));
    };
    if (player.age <= 21) grow(4);
    else if (player.age < PEAK_AGE_MIN) grow(2);
    else if (player.age > 31) fade(4);
    else if (player.age > PEAK_AGE_MAX) fade(2);
  }

  player.contractYears = Math.max(0, player.contractYears - 1);
  player.wage = Math.max(player.wage, fairWage(player));
  player.value = fairValue(player);
  player.yellowsAccum = 0;
  player.condition = 100;
  player.form = 6.0;

  return player.age >= RETIREMENT_AGE && rng.chance(0.6);
}
