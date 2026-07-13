// Club data. Squads are generated deterministically from the club name,
// so the same players (and ratings) appear on every new game.

import { createRng, hashString } from '../engine/rng.js';
import { createPlayer, assignDetailedPositions } from '../engine/players.js';
import { DETAILED_POSITIONS, unitOf } from '../engine/team.js';
import { SQUADS_1995 } from './squads1995.js';

export const FIRST_NAMES = [
  'Alan', 'Eric', 'Ryan', 'Roy', 'Ian', 'Tony', 'Teddy', 'Robbie',
  'Les', 'David', 'Paul', 'Peter', 'Jurgen', 'Gary', 'Phil', 'Lee',
  'Tim', 'Dennis', 'Matthew', 'Matt', 'Nicky', 'Steve', 'Stan', 'Mark',
  'Andy', 'Stuart', 'Darren', 'Kevin', 'Jason', 'John', 'Chris', 'Colin',
];

export const LAST_NAMES = [
  'Shearer', 'Cantona', 'Giggs', 'Keane', 'Wright', 'Adams', 'Sheringham', 'Fowler',
  'Ferdinand', 'Seaman', 'Schmeichel', 'Klinsmann', 'Neville', 'Le Tissier', 'Flowers',
  'Bergkamp', 'McManaman', 'Batty', 'Speed', 'Cole', 'Ince', 'Gascoigne', 'Pallister',
  'Bruce', 'Southgate', 'Redknapp', 'Anderton', 'Stone', 'Barmby', 'Ginola', 'Asprilla',
];

// Squad shape: 18 players per club.
const SQUAD_SHAPE = [
  ['GK', 2], ['DF', 6], ['MF', 6], ['FW', 4],
];

// tier drives squad quality; expectation is the league finish the board
// demands (1-based, within the club's division); capacity drives gates.
const CLUBS = [
  // Division 1
  { name: 'Manchester United', shortName: 'MUN', tier: 92, capacity: 55000, expectation: 1, division: 1 },
  { name: 'Newcastle United', shortName: 'NEW', tier: 89, capacity: 36000, expectation: 2, division: 1 },
  { name: 'Aston Villa', shortName: 'AVL', tier: 86, capacity: 40000, expectation: 3, division: 1 },
  { name: 'Arsenal', shortName: 'ARS', tier: 87, capacity: 38000, expectation: 4, division: 1 },
  { name: 'Liverpool', shortName: 'LIV', tier: 88, capacity: 41000, expectation: 3, division: 1 },
  { name: 'Everton', shortName: 'EVE', tier: 83, capacity: 40000, expectation: 6, division: 1 },
  { name: 'Blackburn Rovers', shortName: 'BLA', tier: 85, capacity: 31000, expectation: 5, division: 1 },
  { name: 'Tottenham Hotspur', shortName: 'TOT', tier: 84, capacity: 33000, expectation: 6, division: 1 },
  { name: 'Nottingham Forest', shortName: 'NFO', tier: 82, capacity: 29000, expectation: 8, division: 1 },
  { name: 'West Ham United', shortName: 'WHU', tier: 80, capacity: 26000, expectation: 10, division: 1 },
  { name: 'Chelsea', shortName: 'CHE', tier: 83, capacity: 34000, expectation: 8, division: 1 },
  { name: 'Middlesbrough', shortName: 'MID', tier: 78, capacity: 30000, expectation: 12, division: 1 },
  { name: 'Leeds United', shortName: 'LEE', tier: 81, capacity: 39000, expectation: 8, division: 1 },
  { name: 'Wimbledon', shortName: 'WIM', tier: 77, capacity: 26000, expectation: 14, division: 1 },
  { name: 'Sheffield Wednesday', shortName: 'SHW', tier: 79, capacity: 39000, expectation: 10, division: 1 },
  { name: 'Coventry City', shortName: 'COV', tier: 75, capacity: 23000, expectation: 16, division: 1 },
  { name: 'Southampton', shortName: 'SOU', tier: 74, capacity: 15000, expectation: 16, division: 1 },
  { name: 'Manchester City', shortName: 'MCI', tier: 76, capacity: 31000, expectation: 14, division: 1 },
  { name: 'Queens Park Rangers', shortName: 'QPR', tier: 73, capacity: 18000, expectation: 18, division: 1 },
  { name: 'Bolton Wanderers', shortName: 'BOL', tier: 71, capacity: 22000, expectation: 20, division: 1 },
  // Division 2
  { name: 'Sunderland', shortName: 'SUN', tier: 72, capacity: 22000, expectation: 1, division: 2 },
  { name: 'Derby County', shortName: 'DER', tier: 71, capacity: 18000, expectation: 2, division: 2 },
  { name: 'Crystal Palace', shortName: 'CRY', tier: 70, capacity: 26000, expectation: 3, division: 2 },
  { name: 'Stoke City', shortName: 'STK', tier: 68, capacity: 22000, expectation: 4, division: 2 },
  { name: 'Charlton Athletic', shortName: 'CHA', tier: 67, capacity: 15000, expectation: 6, division: 2 },
  { name: 'Ipswich Town', shortName: 'IPS', tier: 69, capacity: 22000, expectation: 5, division: 2 },
  { name: 'Port Vale', shortName: 'PTV', tier: 65, capacity: 18000, expectation: 8, division: 2 },
  { name: 'Reading', shortName: 'REA', tier: 66, capacity: 14000, expectation: 8, division: 2 },
  { name: 'Sheffield United', shortName: 'SHU', tier: 68, capacity: 32000, expectation: 6, division: 2 },
  { name: 'Wolverhampton Wanderers', shortName: 'WOL', tier: 69, capacity: 28000, expectation: 6, division: 2 },
  { name: 'Tranmere Rovers', shortName: 'TRA', tier: 64, capacity: 16000, expectation: 10, division: 2 },
  { name: 'Leicester City', shortName: 'LEI', tier: 70, capacity: 21000, expectation: 4, division: 2 },
  { name: 'Barnsley', shortName: 'BAR', tier: 63, capacity: 18000, expectation: 12, division: 2 },
  { name: 'Birmingham City', shortName: 'BIR', tier: 65, capacity: 25000, expectation: 10, division: 2 },
  { name: 'Huddersfield Town', shortName: 'HUD', tier: 62, capacity: 15000, expectation: 14, division: 2 },
  { name: 'Grimsby Town', shortName: 'GRM', tier: 61, capacity: 9000, expectation: 16, division: 2 },
  { name: 'Oldham Athletic', shortName: 'OLD', tier: 63, capacity: 13000, expectation: 14, division: 2 },
  { name: 'Norwich City', shortName: 'NOR', tier: 68, capacity: 21000, expectation: 8, division: 2 },
  { name: 'Millwall', shortName: 'MIL', tier: 60, capacity: 19000, expectation: 18, division: 2 },
  { name: 'Southend United', shortName: 'STD', tier: 59, capacity: 12000, expectation: 20, division: 2 },
];

function generateSquad(club) {
  const rng = createRng(hashString(club.name));
  const usedNames = new Set();
  const players = [];
  let index = 0;

  const realPlayers = SQUADS_1995[club.name] ? [...SQUADS_1995[club.name]] : [];

  for (const [pos, count] of SQUAD_SHAPE) {
    for (let i = 0; i < count; i++) {
      let name;
      let position; // real squads may pin a detailed position, e.g. 'DR'

      const realIndex = realPlayers.findIndex((p) => unitOf(p[1]) === pos);
      if (realIndex !== -1) {
        name = realPlayers[realIndex][0];
        if (DETAILED_POSITIONS.includes(realPlayers[realIndex][1])) {
          position = realPlayers[realIndex][1];
        }
        realPlayers.splice(realIndex, 1);
      } else {
        do {
          name = `${rng.pick(FIRST_NAMES)} ${rng.pick(LAST_NAMES)}`;
        } while (usedNames.has(name));
      }

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
          position,
          atk: Math.min(99, Math.max(1, atk)),
          def: Math.min(99, Math.max(1, def)),
          age: rng.int(17, 33),
        })
      );
    }
  }
  // Detailed positions draw from a parallel seeded stream so their
  // introduction leaves every generated name and attribute untouched.
  return assignDetailedPositions(createRng(hashString(`${club.name}#positions`)), players);
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
