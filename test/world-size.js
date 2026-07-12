// World dimensions derived from the bundled club data, so tests never
// hardcode the club count.

import { TEAMS } from '../src/data/teams.js';

const clubs = TEAMS.length;
const divisions = [1, 2].map((d) => TEAMS.filter((t) => t.division === d).length);

export default {
  clubs,
  divisions,
  // Double round-robin per division plus a knockout cup over all clubs.
  seasonWeeks: 2 * (divisions[0] - 1) + Math.ceil(Math.log2(clubs)),
};
