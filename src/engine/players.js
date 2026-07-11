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

export function createPlayer(rng, { id, name, pos, atk, def, age }) {
  const player = {
    id,
    name,
    pos,
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
