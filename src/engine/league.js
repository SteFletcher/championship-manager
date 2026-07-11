// League: double round-robin fixture generation and table computation.

// Circle-method round robin. Returns rounds: [[{home, away}, ...], ...].
// With n teams, produces 2*(n-1) rounds of n/2 matches (home and away).
export function generateFixtures(teamNames) {
  const names = [...teamNames];
  if (names.length % 2 !== 0) names.push(null); // bye marker
  const n = names.length;
  const half = n / 2;
  const rotation = names.slice(1);
  const firstHalf = [];

  for (let r = 0; r < n - 1; r++) {
    const pairings = [];
    const left = [names[0], ...rotation.slice(0, half - 1)];
    const right = rotation.slice(half - 1).reverse();
    for (let i = 0; i < half; i++) {
      const a = left[i];
      const b = right[i];
      if (a === null || b === null) continue;
      // Alternate the fixed team's venue so home/away is balanced.
      pairings.push(r % 2 === 0 ? { home: a, away: b } : { home: b, away: a });
    }
    firstHalf.push(pairings);
    rotation.push(rotation.shift());
  }

  const secondHalf = firstHalf.map((round) =>
    round.map(({ home, away }) => ({ home: away, away: home }))
  );
  return [...firstHalf, ...secondHalf];
}

export function emptyTableRow(team) {
  return {
    team, played: 0, won: 0, drawn: 0, lost: 0,
    goalsFor: 0, goalsAgainst: 0, goalDiff: 0, points: 0,
  };
}

// results: [{home, away, homeGoals, awayGoals}]
export function computeTable(teamNames, results) {
  const rows = new Map(teamNames.map((t) => [t, emptyTableRow(t)]));
  for (const r of results) {
    const home = rows.get(r.home);
    const away = rows.get(r.away);
    if (!home || !away) throw new Error(`result for unknown team: ${r.home} v ${r.away}`);
    home.played++;
    away.played++;
    home.goalsFor += r.homeGoals;
    home.goalsAgainst += r.awayGoals;
    away.goalsFor += r.awayGoals;
    away.goalsAgainst += r.homeGoals;
    if (r.homeGoals > r.awayGoals) {
      home.won++;
      away.lost++;
      home.points += 3;
    } else if (r.homeGoals < r.awayGoals) {
      away.won++;
      home.lost++;
      away.points += 3;
    } else {
      home.drawn++;
      away.drawn++;
      home.points++;
      away.points++;
    }
  }
  const table = [...rows.values()];
  for (const row of table) row.goalDiff = row.goalsFor - row.goalsAgainst;
  table.sort(
    (a, b) =>
      b.points - a.points ||
      b.goalDiff - a.goalDiff ||
      b.goalsFor - a.goalsFor ||
      a.team.localeCompare(b.team)
  );
  return table;
}
