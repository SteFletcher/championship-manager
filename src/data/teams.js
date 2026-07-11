// Club data. Squads are generated deterministically from the club name,
// so the same players (and ratings) appear on every new game.

import { createRng, hashString } from '../engine/rng.js';
import { createPlayer } from '../engine/players.js';

export const FIRST_NAMES = [
  'Danny', 'Steve', 'Gary', 'Paul', 'Robbie', 'Alan', 'Kevin', 'Dean',
  'Lee', 'Ian', 'Neil', 'Mark', 'Craig', 'Darren', 'Tony', 'Nigel',
  'Matt', 'Chris', 'Jamie', 'Stuart', 'Andy', 'Barry', 'Terry', 'Ray',
];

export const LAST_NAMES = [
  'Sutton', 'Palmer', 'Hendry', 'Marsh', 'Doyle', 'Quinn', 'Barnes',
  'Fletcher', 'Royle', 'Sharpe', 'Whitworth', 'Kane', 'Osgood', 'Pearce',
  'Lawton', 'Vickers', 'Mackay', 'Brogan', 'Stamp', 'Neary', 'Holt',
  'Radford', 'Swann', 'Tudor', 'Ellery', 'Cropper', 'Winstanley', 'Drury',
];

// Squad shape: 18 players per club.
const SQUAD_SHAPE = [
  ['GK', 2], ['DF', 6], ['MF', 6], ['FW', 4],
];

// tier drives squad quality; expectation is the league finish the board
// demands (1-based, within the club's division); capacity drives gates.
const CLUBS = [
  // Division 1
  { name: 'Riverton Athletic', shortName: 'RIV', tier: 88, capacity: 42000, expectation: 2, division: 1 },
  { name: 'Kings Heath United', shortName: 'KHU', tier: 85, capacity: 38000, expectation: 3, division: 1 },
  { name: 'Salt Quay Rovers', shortName: 'SQR', tier: 82, capacity: 33000, expectation: 4, division: 1 },
  { name: 'Blackmoor City', shortName: 'BLA', tier: 79, capacity: 30000, expectation: 5, division: 1 },
  { name: 'Harton Villa', shortName: 'HAR', tier: 76, capacity: 26000, expectation: 6, division: 1 },
  { name: 'Westgate Wanderers', shortName: 'WGW', tier: 73, capacity: 24000, expectation: 7, division: 1 },
  { name: 'Ironbridge Town', shortName: 'IRO', tier: 70, capacity: 21000, expectation: 8, division: 1 },
  { name: 'Millfield Albion', shortName: 'MIL', tier: 67, capacity: 18000, expectation: 9, division: 1 },
  { name: 'Copper Hill FC', shortName: 'COP', tier: 64, capacity: 15000, expectation: 10, division: 1 },
  { name: 'Dunmore County', shortName: 'DUN', tier: 61, capacity: 13000, expectation: 11, division: 1 },
  { name: 'Fenwick Rangers', shortName: 'FEN', tier: 58, capacity: 11000, expectation: 12, division: 1 },
  { name: 'Ashcombe Stanley', shortName: 'ASH', tier: 55, capacity: 9000, expectation: 12, division: 1 },
  // Division 2
  { name: 'Bridgewater Rovers', shortName: 'BRI', tier: 54, capacity: 12000, expectation: 2, division: 2 },
  { name: 'Norchester City', shortName: 'NOR', tier: 52, capacity: 11000, expectation: 3, division: 2 },
  { name: 'Eastvale United', shortName: 'EAS', tier: 51, capacity: 10000, expectation: 4, division: 2 },
  { name: 'Grimsdale Athletic', shortName: 'GRI', tier: 49, capacity: 9000, expectation: 5, division: 2 },
  { name: 'Pellbrook Town', shortName: 'PEL', tier: 48, capacity: 8500, expectation: 6, division: 2 },
  { name: 'Southmere FC', shortName: 'SOU', tier: 46, capacity: 8000, expectation: 7, division: 2 },
  { name: 'Ravenmoor Wanderers', shortName: 'RAV', tier: 45, capacity: 7000, expectation: 8, division: 2 },
  { name: 'Clifton Vale', shortName: 'CLI', tier: 43, capacity: 6500, expectation: 9, division: 2 },
  { name: 'Oakhurst County', shortName: 'OAK', tier: 42, capacity: 6000, expectation: 10, division: 2 },
  { name: 'Wexborough Town', shortName: 'WEX', tier: 40, capacity: 5000, expectation: 11, division: 2 },
  { name: 'Marsh End FC', shortName: 'MAR', tier: 39, capacity: 4500, expectation: 12, division: 2 },
  { name: 'Hollowbrook United', shortName: 'HOL', tier: 38, capacity: 4000, expectation: 12, division: 2 },
];

function generateSquad(club) {
  const rng = createRng(hashString(club.name));
  const usedNames = new Set();
  const players = [];
  let index = 0;

  for (const [pos, count] of SQUAD_SHAPE) {
    for (let i = 0; i < count; i++) {
      let name;
      do {
        name = `${rng.pick(FIRST_NAMES)} ${rng.pick(LAST_NAMES)}`;
      } while (usedNames.has(name));
      usedNames.add(name);

      // First-choice players sit around the club's tier; squad depth
      // players a step below. Everyone is better at their specialism.
      const depthDrop = (pos === 'GK' ? i >= 1 : i >= count - 2) ? rng.int(4, 10) : 0;
      const base = club.tier - depthDrop;
      const spread = () => base + rng.int(-6, 6);
      const weak = () => Math.max(20, base - rng.int(15, 30));
      let atk, def;
      if (pos === 'GK' || pos === 'DF') {
        atk = weak();
        def = spread();
      } else if (pos === 'MF') {
        atk = spread();
        def = spread();
      } else {
        atk = spread();
        def = weak();
      }
      players.push(
        createPlayer(rng, {
          id: `${club.shortName}-${index++}`,
          name,
          pos,
          atk: Math.min(99, Math.max(1, atk)),
          def: Math.min(99, Math.max(1, def)),
          age: rng.int(17, 33),
        })
      );
    }
  }
  return players;
}

// Starting balance and transfer budget scale with stature.
export function clubFinances(tier) {
  const balance = Math.round((tier / 10) ** 3.4 * 3500 / 10000) * 10000;
  return {
    balance,
    transferBudget: Math.round(balance * 0.55 / 5000) * 5000,
  };
}

export function buildClubs() {
  return CLUBS.map((club) => ({
    name: club.name,
    shortName: club.shortName,
    tier: club.tier,
    capacity: club.capacity,
    expectation: club.expectation,
    division: club.division,
    // The fanbase starts below capacity and grows (or shrinks) with
    // results; home attendance — and gate money — follows it.
    fanbase: Math.round(club.capacity * 0.72),
    lastAttendance: 0,
    attendanceSum: 0,
    attendanceN: 0,
    expansion: null, // { seats, weeksLeft } while builders are in
    formGuide: [], // last five results, newest last: 'W' | 'D' | 'L'
    ...clubFinances(club.tier),
    players: generateSquad(club),
  }));
}

export const TEAMS = buildClubs();

export function getTeam(name) {
  return TEAMS.find((t) => t.name === name);
}
