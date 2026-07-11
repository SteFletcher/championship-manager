// Season calendar: one entry per week, merging league rounds and cup days.
// A 12-club league gives 22 league rounds; cup rounds slot in between.

export function buildCalendar(leagueRounds, cupRounds = 4) {
  const calendar = [];
  // Spread the cup rounds evenly through the league season.
  const cupAfter = new Map();
  for (let i = 0; i < cupRounds; i++) {
    cupAfter.set(Math.round((leagueRounds * (i + 1)) / (cupRounds + 1)), i);
  }
  for (let round = 0; round < leagueRounds; round++) {
    calendar.push({ type: 'league', round });
    if (cupAfter.has(round + 1)) {
      calendar.push({ type: 'cup', cupRound: cupAfter.get(round + 1) });
    }
  }
  return calendar;
}

// Month boundaries for player-of-the-month awards: every 4 calendar weeks.
export const WEEKS_PER_MONTH = 4;

export function monthOf(week) {
  return Math.floor(week / WEEKS_PER_MONTH);
}

export const MONTH_NAMES = [
  'August', 'September', 'October', 'November', 'December', 'January',
  'February', 'March', 'April', 'May', 'June', 'July',
];

export function monthName(week) {
  return MONTH_NAMES[monthOf(week) % MONTH_NAMES.length];
}
