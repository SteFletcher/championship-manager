// Knockout cup with a random draw each round. Handles any entrant count:
// an opening round (with byes drawn as needed) trims the field to the
// largest power of two below it, then it halves to the final. Ties are
// single-leg with extra time and penalties.

// The field size the opening round reduces to: 12 -> 8, 24 -> 16, 16 -> 8.
export function openingTarget(nTeams) {
  return 2 ** Math.floor(Math.log2(nTeams - 1));
}

// Total number of rounds for a given entrant count: 12 -> 4, 24 -> 5.
export function cupRoundCount(nTeams) {
  return 1 + Math.log2(openingTarget(nTeams));
}

// Round names by the number of teams still in when the round is played.
function roundNameFor(survivors) {
  const named = { 2: 'Final', 4: 'Semi-Final', 8: 'Quarter-Final', 16: 'Round of 16' };
  return named[survivors] ?? 'First Round';
}

// Names of every round for a given entrant count, in order.
export function cupRoundNames(nTeams) {
  const names = [roundNameFor(nTeams)];
  for (let n = openingTarget(nTeams); n >= 2; n /= 2) {
    if (n !== nTeams) names.push(roundNameFor(n));
  }
  return names;
}

// Draw a round's ties from the surviving team names. Byes are drawn so
// the next round has exactly `target` teams.
export function drawRound(rng, teamNames, target) {
  const pool = [...teamNames];
  // Shuffle (Fisher-Yates) using the shared rng for determinism.
  for (let i = pool.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const tiesNeeded = pool.length - target;
  const ties = [];
  for (let i = 0; i < tiesNeeded; i++) {
    ties.push({ home: pool[i * 2], away: pool[i * 2 + 1] });
  }
  const byes = pool.slice(tiesNeeded * 2);
  return { ties, byes };
}

export function createCup(rng, teamNames) {
  const { ties, byes } = drawRound(rng, teamNames, openingTarget(teamNames.length));
  return {
    roundIndex: 0,
    ties, // current round's pairings
    byes, // teams skipping the current round
    results: [], // kept for save-shape stability
    winner: null,
  };
}

export function cupRoundName(cup) {
  if (cup.winner) return 'Winner';
  return roundNameFor(cup.byes.length + cup.ties.length * 2);
}

// Record this round's tie winners and draw the next round.
// tieWinners must be aligned with cup.ties.
export function advanceCup(rng, cup, tieWinners) {
  if (tieWinners.length !== cup.ties.length) {
    throw new Error(`expected ${cup.ties.length} winners, got ${tieWinners.length}`);
  }
  const survivors = [...cup.byes, ...tieWinners];
  cup.roundIndex++;
  cup.byes = [];
  if (survivors.length === 1) {
    cup.winner = survivors[0];
    cup.ties = [];
    return cup;
  }
  const { ties } = drawRound(rng, survivors, survivors.length / 2);
  cup.ties = ties;
  return cup;
}

// Is this team still alive in the cup?
export function inCup(cup, teamName) {
  if (cup.winner) return cup.winner === teamName;
  return (
    cup.byes.includes(teamName) ||
    cup.ties.some((t) => t.home === teamName || t.away === teamName)
  );
}
