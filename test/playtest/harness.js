import { Game } from '../../src/engine/game.js';
import { POLICIES } from './policies.js';

export const DEFAULT_PLAYTEST = Object.freeze({
  clubName: 'Bolton Wanderers',
  managerName: 'Deterministic Tester',
  seed: 0x5eed1234,
  seasons: 5,
});

function validateMatch(result) {
  const goals = result.events.filter((event) => event.type === 'goal');
  if (goals.filter((event) => event.side === 'home').length !== result.score.home ||
      goals.filter((event) => event.side === 'away').length !== result.score.away) {
    throw new Error(`seed ${result.seed}: score does not match goal events`);
  }
  for (const side of ['home', 'away']) {
    const stats = result.stats[side];
    if (stats.shots < stats.onTarget || stats.onTarget < result.score[side]) {
      throw new Error(`seed ${result.seed}: invalid ${side} shot funnel`);
    }
  }
  if (result.stats.home.possession + result.stats.away.possession !== 100) {
    throw new Error(`seed ${result.seed}: possession does not total 100`);
  }
  if (result.events.at(-1)?.type !== 'full-time') {
    throw new Error(`seed ${result.seed}: match did not reach full time`);
  }
}

function playLiveMatch(game, policy) {
  const preMatchActions = policy.beforeMatch(game) ?? [];
  const { sim, fixture, userSide } = game.startUserMatch();
  const liveActions = [];
  while (!sim.finished) {
    sim.playMinute();
    liveActions.push(...(policy.duringMatch(sim, userSide) ?? []));
  }
  const result = sim.finish();
  validateMatch(result);
  return { fixture, userSide, result, actions: [...preMatchActions, ...liveActions] };
}

function takeAvailableJob(game) {
  if (!game.sacked) return null;
  const clubName = [...game.jobOffers]
    .sort((a, b) =>
      game.getClub(b).expectation - game.getClub(a).expectation ||
      game.getClub(b).tier - game.getClub(a).tier)[0];
  if (!clubName) return null;
  const result = game.acceptJob(clubName);
  return result.ok ? clubName : null;
}

export function runCareer(policy, options = {}) {
  const config = { ...DEFAULT_PLAYTEST, ...options };
  let game = new Game(config);
  const initial = {
    clubName: game.clubName,
    reputation: game.reputation,
    playerIds: game.club.players.map((player) => player.id).sort(),
  };
  const matches = [];
  const managementActions = [];
  const jobs = [];
  const campaigns = [];
  const history = [];
  let completedSeasons = 0;
  let campaign = 0;
  let weeks = 0;

  while (completedSeasons < config.seasons) {
    if (game.sacked) {
      const nextClub = takeAvailableJob(game);
      if (nextClub) {
        jobs.push({ campaign, season: completedSeasons, week: game.week, clubName: nextClub });
      } else {
        campaigns.push({
          campaign,
          completedSeasons: game.seasonIndex,
          terminal: 'sacked-without-offers',
        });
        campaign++;
        game = new Game({
          managerName: config.managerName,
          clubName: config.clubName,
          seed: (config.seed + campaign * 7919) >>> 0,
        });
        continue;
      }
    }

    managementActions.push(...(policy.beforeWeek(game) ?? []));
    const played = game.userFixture() ? playLiveMatch(game, policy) : null;
    if (played) matches.push({
      campaign,
      season: completedSeasons,
      week: game.week,
      competition: played.fixture.type,
      userSide: played.userSide,
      result: played.result,
      actions: played.actions,
    });
    const historyBefore = game.history.length;
    game.advanceWeek(played?.result ?? null);
    if (game.history.length > historyBefore) {
      const season = game.history.at(-1);
      history.push({ ...season, campaign, simulatedSeason: completedSeasons });
      completedSeasons++;
    }
    weeks++;
    if (weeks > config.seasons * 160) throw new Error('playtest exceeded its week safety limit');
  }

  campaigns.push({ campaign, completedSeasons: game.seasonIndex, terminal: 'sample-complete' });

  return {
    policy: policy.id,
    description: policy.description,
    seed: config.seed,
    requestedSeasons: config.seasons,
    completedSeasons,
    weeks,
    matches,
    managementActions,
    jobs,
    campaigns,
    history,
    initial,
    final: {
      clubName: game.clubName,
      reputation: game.reputation,
      boardConfidence: game.board.confidence,
      balance: game.club.balance,
      playerIds: game.club.players.map((player) => player.id).sort(),
      sacked: game.sacked,
    },
    finalSave: game.serialize(),
  };
}

export function runPlaytestSuite(options = {}) {
  return POLICIES.map((policy, index) => runCareer(policy, {
    ...options,
    seed: ((options.seed ?? DEFAULT_PLAYTEST.seed) + index * 1009) >>> 0,
  }));
}
