import { isAvailable } from '../../src/engine/players.js';

const action = (type, ok, changed = ok, detail = {}) => ({ type, ok, changed, ...detail });

function rejectOffers(game) {
  return [...game.pendingOffers].map((offer) => {
    const result = game.respondToOffer(offer.id, false);
    return action('offer', result.ok, result.ok, { accepted: false });
  });
}

function continueCareer(game) {
  if (!game.pendingJobOffer) return [];
  const result = game.respondToJobOffer(false);
  return [action('job-offer', result.ok, result.ok, { accepted: false })];
}

function renewExpiringContracts(game) {
  return game.club.players
    .filter((player) => player.contractYears <= 1)
    .map((player) => {
      const result = game.renewContract(player.id);
      return action('contract', result.ok, result.ok, { playerId: player.id });
    });
}

function maintainPlayableSquad(game) {
  const actions = [];
  const attempted = new Set();
  const needsDepth = () =>
    game.club.players.length < 18 || game.club.players.filter(isAvailable).length < 11;
  while (needsDepth() && attempted.size < 12) {
    const ceiling = Math.min(game.club.transferBudget, Math.max(0, game.club.balance));
    const ownNames = new Set(game.club.players.map((player) => player.name));
    const target = game.searchPlayers({})
      .find((row) => !attempted.has(row.player.id) &&
        !ownNames.has(row.player.name) &&
        (row.club === null || row.asking <= ceiling));
    if (!target) break;
    attempted.add(target.player.id);
    const result = game.bid(target.player.id, target.asking);
    actions.push(action('squad-depth', result.status !== 'rejected', result.status === 'accepted', {
      status: result.status,
      playerId: target.player.id,
    }));
  }
  return actions;
}

function scoutAndRecruit(game) {
  const actions = [];
  if (game.week === 0 && game.pendingScouts.length === 0) {
    const ownNames = new Set(game.club.players.map((player) => player.name));
    const target = game.searchPlayers({})
      .find((row) => row.club && !ownNames.has(row.player.name) &&
        row.asking <= game.club.transferBudget * 0.5);
    if (target) {
      const result = game.scoutPlayer(target.player.id);
      actions.push(action('scout', result.ok, result.ok, { playerId: target.player.id }));
    }
  }

  if (game.week === 1 && game.club.players.length < 22) {
    const ceiling = Math.min(game.club.transferBudget * 0.4, game.club.balance * 0.2);
    const target = game.searchPlayers({})
      .find((row) => game.scouted[row.player.id] && row.asking <= ceiling);
    if (target) {
      const result = game.bid(target.player.id, target.asking);
      actions.push(action('transfer', result.status !== 'rejected', result.status === 'accepted', {
        status: result.status,
        playerId: target.player.id,
      }));
    }
  }
  return actions;
}

function makeFreshLegsSub(sim, sideKey) {
  const side = sim.sides[sideKey];
  const off = [...side.onPitch]
    .filter((entry) => entry.slot !== 'GK')
    .sort((a, b) => side.lines.get(a.player.id).condition - side.lines.get(b.player.id).condition)[0];
  if (!off || side.benchLeft.length === 0) return action('substitution', false, false);
  const on = side.benchLeft.find((player) => player.pos !== 'GK') ?? side.benchLeft[0];
  const result = sim.makeSub(sideKey, off.player.id, on.id);
  return action('substitution', result.ok, result.ok, { minute: sim.minute });
}

function adaptiveLive(sim, sideKey) {
  const actions = [];
  const own = sim.score[sideKey];
  const other = sim.score[sideKey === 'home' ? 'away' : 'home'];
  if (sim.minute === 60) {
    const result = own < other
      ? sim.setTactics(sideKey, { formation: '4-3-3', mentality: 'attacking' })
      : sim.setTactics(sideKey, { formation: '5-3-2', mentality: 'defensive' });
    actions.push(action('tactics', result.ok, result.changed, { minute: sim.minute }));
  }
  if (sim.minute === 65) actions.push(makeFreshLegsSub(sim, sideKey));
  if (sim.minute === 75) {
    const outfielder = sim.sides[sideKey].onPitch.find((entry) => entry.slot !== 'GK');
    if (outfielder) {
      const value = own <= other ? 'forward' : 'hold';
      const result = sim.setInstruction(sideKey, outfielder.player.id, 'runs', value);
      actions.push(action('instruction', result.ok, result.changed, { minute: sim.minute }));
    }
  }
  return actions;
}

function aggressiveLive(sim, sideKey) {
  if (sim.minute === 65) return [makeFreshLegsSub(sim, sideKey)];
  return [];
}

export const POLICIES = [
  {
    id: 'passive',
    description: 'Keeps the default shape and delegates match management.',
    beforeWeek(game) {
      return [
        ...rejectOffers(game),
        ...continueCareer(game),
        ...renewExpiringContracts(game),
        ...maintainPlayableSquad(game),
      ];
    },
    beforeMatch() { return []; },
    duringMatch() { return []; },
  },
  {
    id: 'adaptive',
    description: 'Manages contracts and recruitment, then reacts to the score in-play.',
    beforeWeek(game) {
      return [
        ...rejectOffers(game),
        ...continueCareer(game),
        ...renewExpiringContracts(game),
        ...maintainPlayableSquad(game),
        ...scoutAndRecruit(game),
      ];
    },
    beforeMatch(game) {
      const chasing = game.leaguePosition() > game.club.expectation;
      const next = chasing
        ? { formation: '4-3-3', mentality: 'attacking' }
        : { formation: '4-4-2', mentality: 'normal' };
      const changed = game.tactics.formation !== next.formation ||
        game.tactics.mentality !== next.mentality;
      game.setTactics(next);
      return [action('pre-match-tactics', true, changed)];
    },
    duringMatch: adaptiveLive,
  },
  {
    id: 'aggressive',
    description: 'Uses a high-risk attacking shape and proactive pressing.',
    beforeWeek(game) {
      return [
        ...rejectOffers(game),
        ...continueCareer(game),
        ...renewExpiringContracts(game),
        ...maintainPlayableSquad(game),
      ];
    },
    beforeMatch(game) {
      const changed = game.tactics.formation !== '4-3-3' || game.tactics.mentality !== 'attacking';
      game.setTactics({ formation: '4-3-3', mentality: 'attacking' });
      for (let slot = 1; slot < 11; slot++) game.setSlotInstruction(slot, 'press', 'high');
      return [action('pre-match-tactics', true, changed)];
    },
    duringMatch: aggressiveLive,
  },
];

export function policyById(id) {
  const policy = POLICIES.find((candidate) => candidate.id === id);
  if (!policy) throw new Error(`unknown playtest policy: ${id}`);
  return policy;
}
