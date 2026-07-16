const clamp01 = (value) => Math.max(0, Math.min(1, value));
const ratio = (value, target) => target === 0 ? 0 : clamp01(value / target);
const round = (value) => Math.round(value * 10) / 10;
const mean = (values) => values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;

export const FUN_BASELINE = Object.freeze({
  overall: 55,
  drama: 35,
  variety: 45,
  agency: 40,
  progression: 55,
  pacing: 50,
});

function goalStory(match) {
  let home = 0;
  let away = 0;
  let equalizers = 0;
  let lateGoals = 0;
  const leaders = new Set();
  for (const event of match.result.events.filter((candidate) => candidate.type === 'goal')) {
    if (event.side === 'home') home++;
    else away++;
    if (event.minute >= 75) lateGoals++;
    if (home === away) equalizers++;
    else leaders.add(home > away ? 'home' : 'away');
  }
  return {
    close: Math.abs(home - away) <= 1,
    lateGoal: lateGoals > 0,
    equalizer: equalizers > 0,
    comeback: leaders.size > 1,
  };
}

function entropy(values) {
  if (values.length === 0) return 0;
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  if (counts.size === 1) return 0;
  const raw = [...counts.values()].reduce((sum, count) => {
    const p = count / values.length;
    return sum - p * Math.log2(p);
  }, 0);
  return raw / Math.log2(counts.size);
}

function targetScore(value, ideal, tolerance) {
  return clamp01(1 - Math.abs(value - ideal) / tolerance);
}

export function assessFun(sessions) {
  const matches = sessions.flatMap((session) =>
    session.matches.map((match) => ({ ...match, policy: session.policy })));
  const stories = matches.map(goalStory);
  const scorelines = matches.map((match) => `${match.result.score.home}-${match.result.score.away}`);
  const outcomes = matches.map((match) => {
    const own = match.result.score[match.userSide];
    const other = match.result.score[match.userSide === 'home' ? 'away' : 'home'];
    return own > other ? 'win' : own < other ? 'loss' : 'draw';
  });

  const drama = 100 * (
    mean(stories.map((story) => story.close ? 1 : 0)) * 0.35 +
    ratio(mean(stories.map((story) => story.lateGoal ? 1 : 0)), 0.45) * 0.25 +
    ratio(mean(stories.map((story) => story.equalizer ? 1 : 0)), 0.30) * 0.20 +
    ratio(mean(stories.map((story) => story.comeback ? 1 : 0)), 0.12) * 0.20
  );

  const variety = 100 * (
    ratio(new Set(scorelines).size, 12) * 0.45 +
    entropy(scorelines) * 0.30 +
    entropy(outcomes) * 0.25
  );

  const decisionTypes = new Set(['pre-match-tactics', 'tactics', 'instruction', 'substitution']);
  const decisions = matches.flatMap((match) => match.actions.filter((item) => decisionTypes.has(item.type)));
  const validDecisions = decisions.filter((item) => item.ok).length;
  const managedMatches = matches.filter((match) => match.actions.some((item) =>
    decisionTypes.has(item.type) && item.ok)).length;
  const policyScores = new Map(sessions.map((session) => [
    session.policy,
    session.matches.map((match) => `${match.result.score.home}-${match.result.score.away}`),
  ]));
  const policyPairs = [];
  const lists = [...policyScores.values()];
  for (let a = 0; a < lists.length; a++) {
    for (let b = a + 1; b < lists.length; b++) {
      const length = Math.min(lists[a].length, lists[b].length);
      for (let i = 0; i < length; i++) policyPairs.push(lists[a][i] !== lists[b][i] ? 1 : 0);
    }
  }
  const agency = 100 * (
    (decisions.length ? validDecisions / decisions.length : 0) * 0.35 +
    ratio(managedMatches / Math.max(1, matches.length), 0.55) * 0.30 +
    mean(policyPairs) * 0.35
  );

  const requested = sessions.reduce((sum, session) => sum + session.requestedSeasons, 0);
  const completed = sessions.reduce((sum, session) => sum + session.completedSeasons, 0);
  const positionChanges = sessions.flatMap((session) => session.history.slice(1).map((season, index) =>
    season.userPosition !== session.history[index].userPosition ? 1 : 0));
  const rosterTurnover = mean(sessions.map((session) => {
    const initial = new Set(session.initial.playerIds);
    return session.final.playerIds.filter((id) => !initial.has(id)).length /
      Math.max(1, session.final.playerIds.length);
  }));
  const progression = 100 * (
    (completed / Math.max(1, requested)) * 0.50 +
    mean(positionChanges) * 0.25 +
    ratio(rosterTurnover, 0.25) * 0.25
  );

  const goalsPerMatch = mean(matches.map((match) => match.result.score.home + match.result.score.away));
  const shotsPerMatch = mean(matches.map((match) =>
    match.result.stats.home.shots + match.result.stats.away.shots));
  const cardsPerMatch = mean(matches.map((match) =>
    match.result.stats.home.yellowCards + match.result.stats.away.yellowCards +
    match.result.stats.home.redCards + match.result.stats.away.redCards));
  const pacing = 100 * (
    targetScore(goalsPerMatch, 2.7, 2.2) * 0.45 +
    targetScore(shotsPerMatch, 24, 14) * 0.35 +
    targetScore(cardsPerMatch, 3.5, 3.5) * 0.20
  );

  const components = {
    drama: round(drama),
    variety: round(variety),
    agency: round(agency),
    progression: round(progression),
    pacing: round(pacing),
  };
  const overall = round(
    components.drama * 0.30 + components.variety * 0.20 +
    components.agency * 0.20 + components.progression * 0.15 +
    components.pacing * 0.15
  );
  return {
    overall,
    components,
    observations: {
      matches: matches.length,
      seasons: completed,
      goalsPerMatch: round(goalsPerMatch),
      shotsPerMatch: round(shotsPerMatch),
      closeMatchRate: round(mean(stories.map((story) => story.close ? 1 : 0))),
      lateGoalRate: round(mean(stories.map((story) => story.lateGoal ? 1 : 0))),
      policyDivergenceRate: round(mean(policyPairs)),
      validDecisionRate: round(decisions.length ? validDecisions / decisions.length : 0),
      distinctScorelines: new Set(scorelines).size,
    },
    verdict: overall >= FUN_BASELINE.overall
      ? 'The deterministic indicators support a fun, varied career loop.'
      : 'The deterministic indicators suggest a gameplay regression worth human review.',
    caveat: 'This is a repeatable design-health signal, not a substitute for human playtesting.',
  };
}

export function baselineFailures(assessment, baseline = FUN_BASELINE) {
  const scores = { overall: assessment.overall, ...assessment.components };
  return Object.entries(baseline)
    .filter(([name, minimum]) => scores[name] < minimum)
    .map(([name, minimum]) => `${name} ${scores[name]} < ${minimum}`);
}
