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
// Mutates the player; returns true if the player retires.
export function developPlayer(rng, player) {
  player.age++;
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

  player.contractYears = Math.max(0, player.contractYears - 1);
  player.wage = Math.max(player.wage, fairWage(player));
  player.value = fairValue(player);
  player.yellowsAccum = 0;
  player.condition = 100;
  player.form = 6.0;

  return player.age >= RETIREMENT_AGE && rng.chance(0.6);
}
