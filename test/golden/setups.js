// Deterministic match setups for the golden-master fixtures.
//
// Every case must be exactly reconstructible from this file: fixed seeds,
// fixed squads (real club data is itself generated deterministically from
// club names), no ambient randomness. Cases cover the three setup shapes
// MatchSim accepts (full squad, explicit XI, prepared lineup), league and
// knockout, home advantage on and off, and the player-modifier paths
// (morale/form/consistency/condition).

import { TEAMS } from '../../src/data/teams.js';
import { simulateMatch } from '../../src/engine/match.js';

const clamp = (v) => Math.min(99, Math.max(1, Math.round(v)));

// An explicit XI with deterministic per-player variation.
export function makeXi(name, level, mods = {}) {
  const slots = ['GK', 'DF', 'DF', 'DF', 'DF', 'MF', 'MF', 'MF', 'MF', 'FW', 'FW'];
  return {
    name,
    shortName: name.slice(0, 3).toUpperCase(),
    players: slots.map((pos, i) => {
      const wobble = ((i * 7) % 11) - 5;
      const base = {
        GK: { atk: 20, def: level + 8 },
        DF: { atk: level - 15, def: level + 4 },
        MF: { atk: level, def: level },
        FW: { atk: level + 5, def: level - 15 },
      }[pos];
      return {
        id: `${name}-${i}`,
        name: `${name} ${pos}${i}`,
        pos,
        atk: clamp(base.atk + wobble),
        def: clamp(base.def + wobble),
        ...mods,
      };
    }),
  };
}

function makeBench(name, level) {
  return [
    { id: `${name}-b0`, name: `${name} SubGK`, pos: 'GK', atk: 18, def: level - 4 },
    { id: `${name}-b1`, name: `${name} SubDF`, pos: 'DF', atk: level - 20, def: level },
    { id: `${name}-b2`, name: `${name} SubMF`, pos: 'MF', atk: level - 6, def: level - 6 },
  ];
}

// A prepared lineup ({starters, bench, formation, mentality}) including one
// out-of-position starter so the familiarity/penalty path is pinned.
function makePrepared(name, level, formation, mentality) {
  const xi = makeXi(name, level);
  const p = xi.players;
  const slotPlans = {
    '4-3-3': [
      ['GK', 0], ['DF', 1], ['DF', 2], ['DF', 3], ['DF', 4],
      ['MF', 5], ['MF', 6], ['MF', 7],
      ['FW', 8] /* natural MF, out of position */, ['FW', 9], ['FW', 10],
    ],
    '5-3-2': [
      ['GK', 0], ['DF', 1], ['DF', 2], ['DF', 3], ['DF', 4],
      ['DF', 5] /* natural MF, out of position */,
      ['MF', 6], ['MF', 7], ['MF', 8], ['FW', 9], ['FW', 10],
    ],
  };
  return {
    name: xi.name,
    shortName: xi.shortName,
    starters: slotPlans[formation].map(([slot, i]) => ({ player: p[i], slot })),
    bench: makeBench(name, level),
    formation,
    mentality,
  };
}

function withBench(xi, level) {
  return { ...xi, bench: makeBench(xi.name, level) };
}

export const GOLDEN_CASES = [
  { name: 'full-squads-league-top', kind: 'full', seed: 1189, home: 0, away: 1 },
  { name: 'full-squads-league-mid', kind: 'full', seed: 2204, home: 4, away: 9 },
  { name: 'full-squads-cross-division', kind: 'full', seed: 3311, home: 2, away: 14 },
  { name: 'full-squads-knockout', kind: 'full', seed: 5150, home: 6, away: 18, knockout: true },
  { name: 'full-squads-no-home-advantage', kind: 'full', seed: 8080, home: 3, away: 5, homeAdvantage: false },
  { name: 'xi-even-league', kind: 'xi', seed: 7, levels: [70, 70] },
  { name: 'xi-mismatch-league', kind: 'xi', seed: 4242, levels: [82, 58] },
  { name: 'xi-modifiers-league', kind: 'xi', seed: 1717, levels: [72, 72], mods: { morale: 85, form: 7.5, consistency: 60, condition: 92 } },
  { name: 'xi-knockout-shootout', kind: 'xi', seed: 9, levels: [70, 70], knockout: true },
  { name: 'prepared-attacking-433', kind: 'prepared', seed: 909, levels: [74, 68] },
  { name: 'prepared-defensive-532-knockout', kind: 'prepared', seed: 6060, levels: [66, 66], knockout: true },
];

export function buildCase(c) {
  let home;
  let away;
  if (c.kind === 'full') {
    home = TEAMS[c.home];
    away = TEAMS[c.away];
  } else if (c.kind === 'xi') {
    home = withBench(makeXi('Golden Home', c.levels[0], c.mods ?? {}), c.levels[0] - 4);
    away = withBench(makeXi('Golden Away', c.levels[1], c.mods ?? {}), c.levels[1] - 4);
  } else if (c.kind === 'prepared') {
    home = makePrepared('Golden Home', c.levels[0], '4-3-3', 'attacking');
    away = makePrepared('Golden Away', c.levels[1], '5-3-2', 'defensive');
  } else {
    throw new Error(`unknown golden case kind: ${c.kind}`);
  }
  return {
    home,
    away,
    options: {
      seed: c.seed,
      knockout: c.knockout ?? false,
      homeAdvantage: c.homeAdvantage ?? true,
    },
  };
}

export function runCase(c) {
  const { home, away, options } = buildCase(c);
  return simulateMatch(home, away, options);
}
