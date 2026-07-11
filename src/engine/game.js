// Game state: the management layer that owns a career.
//
// Wraps the match engine with a season structure (league + cup), squads
// with injuries/suspensions/condition/form/morale, transfers, finances,
// board confidence, news, awards, end-of-season development, and
// serialization for save games.

import { createRng, hashString } from './rng.js';
import { MatchSim, simulateMatch } from './match.js';
import { selectXI, overallRating, FORMATIONS, MENTALITIES } from './team.js';
import { developPlayer, isAvailable, ability } from './players.js';
import { generateFixtures, computeTable } from './league.js';
import {
  createCup, advanceCup, cupRoundName, cupRoundCount, cupRoundNames, inCup,
} from './cup.js';
import { buildCalendar, monthName, WEEKS_PER_MONTH } from './season.js';
import {
  askingPrice, evaluateBid, wageDemand, playerAgrees,
  aiInterest, aiOfferAmount, freeAgentWage, canRelease,
} from './transfers.js';
import { buildClubs, FIRST_NAMES, LAST_NAMES } from '../data/teams.js';

const TICKET_PRICE = 14;
const WIN_MORALE = 8;
const DRAW_MORALE = 1;
const LOSS_MORALE = -6;
const SACK_THRESHOLD = 15;
const SAVE_VERSION = 6;
const JOB_REACH = 15; // how far above your reputation a club will hire
const SCOUT_FEE = 15000;
const MASK_HALF_WIDTH = 8; // unscouted attributes show as a range this wide
export const DIVISIONS = [1, 2];

// Stadium expansion: build cost per new seat, build time, and the demand
// the board wants to see before approving (fanbase vs current capacity).
const EXPANSION_COST_PER_SEAT = 220;
const EXPANSION_WEEKS = 8;
const EXPANSION_DEMAND = 0.85;
const EXPANSION_STEP = 0.15; // grow the ground by 15% at a time

// Fanbase economics: results move the number of supporters, and home
// attendance (capped by the stadium) follows the fanbase.
const FAN_WIN = 1.008;
const FAN_DRAW = 1.001;
const FAN_LOSS = 0.996;
const FAN_MIN = 2000;
const FAN_MAX_OF_CAPACITY = 1.6;

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

function emptySeasonStats() {
  return {}; // playerId -> {apps, goals, assists, ratingSum, ratingN, motm}
}

export class Game {
  constructor({ managerName, clubName, seed = Date.now() >>> 0 }) {
    this.version = SAVE_VERSION;
    this.managerName = managerName;
    this.clubName = clubName;
    this.rng = createRng(seed);
    this.clubs = buildClubs();
    if (!this.club) throw new Error(`unknown club: ${clubName}`);
    this.freeAgents = [];
    this.seasonIndex = 0;
    this.week = 0;
    this.calendar = buildCalendar(this.leagueRounds, cupRoundCount(this.clubs.length));
    this.fixtures = this.#generateAllFixtures();
    this.results = [];
    this.cup = createCup(this.rng, this.clubs.map((c) => c.name));
    this.cupResults = [];
    this.seasonStats = emptySeasonStats();
    this.monthly = {}; // playerId -> {sum, n} within the current month
    this.inbox = [];
    this.pendingOffers = []; // AI offers for the user's players
    this.nextOfferId = 1;
    this.board = { confidence: 60 };
    this.tactics = { formation: '4-4-2', mentality: 'normal' };
    this.history = [];
    this.youthSeq = 0;
    this.sacked = false;
    // Managerial standing: starts a notch below the club's stature and
    // moves with seasons, trophies, and sackings.
    this.reputation = clamp(this.club.tier - 10, 20, 70);
    this.jobOffers = []; // post-sack club names willing to hire
    this.pendingJobOffer = null; // a bigger club come calling mid-career
    this.scouted = {}; // playerId -> true once a scout has filed a report
    this.pendingScouts = []; // [{ playerId, weeksLeft }]
    this.lastResults = []; // most recent matchday's results, for the UI

    this.news('Welcome to the job',
      `The board of ${clubName} welcome ${managerName} as the club's new manager. ` +
      `They expect a finish of ${this.ordinal(this.club.expectation)} place or better.`);
  }

  divisionClubs(division) {
    return this.clubs.filter((c) => c.division === division);
  }

  get leagueRounds() {
    return (this.divisionClubs(1).length - 1) * 2;
  }

  #generateAllFixtures() {
    const fixtures = {};
    for (const d of DIVISIONS) {
      fixtures[d] = generateFixtures(this.divisionClubs(d).map((c) => c.name));
    }
    return fixtures;
  }

  cupRoundLabel(index) {
    return cupRoundNames(this.clubs.length)[index] ?? `Round ${index + 1}`;
  }

  get club() {
    return this.clubs.find((c) => c.name === this.clubName);
  }

  getClub(name) {
    return this.clubs.find((c) => c.name === name);
  }

  findPlayer(id) {
    for (const club of this.clubs) {
      const player = club.players.find((p) => p.id === id);
      if (player) return { player, club };
    }
    const fa = this.freeAgents.find((p) => p.id === id);
    return fa ? { player: fa, club: null } : null;
  }

  ordinal(n) {
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }

  news(subject, body, extra = {}) {
    this.inbox.unshift({
      week: this.week, season: this.seasonIndex, subject, body, ...extra,
    });
    if (this.inbox.length > 120) this.inbox.length = 120;
  }

  // --- Season position ----------------------------------------------------

  divisionTable(division) {
    const names = this.divisionClubs(division).map((c) => c.name);
    const nameSet = new Set(names);
    return computeTable(names, this.results.filter((r) => nameSet.has(r.home)));
  }

  // The user's division table.
  get table() {
    return this.divisionTable(this.club.division);
  }

  leaguePosition(clubName = this.clubName) {
    const division = this.getClub(clubName).division;
    return this.divisionTable(division).findIndex((r) => r.team === clubName) + 1;
  }

  currentEvent() {
    return this.calendar[this.week] ?? null;
  }

  // The user's fixture this week, or null (no fixture / eliminated / bye).
  userFixture() {
    const event = this.currentEvent();
    if (!event) return null;
    const pairings = event.type === 'league'
      ? this.fixtures[this.club.division][event.round]
      : this.cup.ties;
    const tie = pairings.find(
      (p) => p.home === this.clubName || p.away === this.clubName
    );
    if (!tie) return null;
    return {
      ...tie,
      type: event.type,
      round: event.type === 'league' ? event.round + 1 : cupRoundName(this.cup),
      knockout: event.type === 'cup',
      isHome: tie.home === this.clubName,
    };
  }

  // --- Lineups --------------------------------------------------------------

  defaultLineup(clubName = this.clubName) {
    const club = this.getClub(clubName);
    const formation = clubName === this.clubName ? this.tactics.formation : '4-4-2';
    return selectXI(club.players, formation);
  }

  aiSetup(clubName) {
    const club = this.getClub(clubName);
    return {
      name: club.name,
      shortName: club.shortName,
      players: club.players,
      formation: '4-4-2',
      mentality: 'normal',
    };
  }

  userSetup(lineup = null) {
    const club = this.club;
    const picked = lineup ?? this.defaultLineup();
    return {
      name: club.name,
      shortName: club.shortName,
      starters: picked.starters,
      bench: picked.bench,
      formation: picked.formation ?? this.tactics.formation,
      mentality: this.tactics.mentality,
    };
  }

  // Today's gate for a home club, drawn from its fanbase.
  drawAttendance(homeClub, competition) {
    const cupBoost = competition === 'cup' ? 1.12 : 1;
    const turnout = 0.82 + this.rng.next() * 0.22;
    return Math.min(
      homeClub.capacity,
      Math.round(homeClub.fanbase * turnout * cupBoost)
    );
  }

  // Create the live sim for the user's match this week.
  startUserMatch(lineup = null) {
    const fixture = this.userFixture();
    if (!fixture) throw new Error('no user fixture this week');
    const user = this.userSetup(lineup);
    const oppName = fixture.isHome ? fixture.away : fixture.home;
    const opp = this.aiSetup(oppName);
    const sim = new MatchSim(
      fixture.isHome ? user : opp,
      fixture.isHome ? opp : user,
      {
        seed: this.rng.int(0, 2 ** 31),
        knockout: fixture.knockout,
        autoSubs: { [fixture.isHome ? 'home' : 'away']: false },
      }
    );
    // Draw the gate now so the matchday screen can show it; the week's
    // bookkeeping consumes this same figure.
    const attendance = this.drawAttendance(
      this.getClub(fixture.home), fixture.type
    );
    this.userMatchAttendance = attendance;
    return { sim, fixture, userSide: fixture.isHome ? 'home' : 'away', attendance };
  }

  // --- Advancing time -------------------------------------------------------

  // Play out the current week. If the user's match was played live, pass
  // its finished result; otherwise it is simulated automatically.
  advanceWeek(userResult = null) {
    if (this.sacked) throw new Error('you have been sacked');
    const event = this.currentEvent();
    this.lastResults = [];

    if (event) {
      if (event.type === 'league') this.#playLeagueRound(event.round, userResult);
      else this.#playCupRound(userResult);
    }

    this.#weeklyUpkeep();
    this.#tickExpansions();
    this.#tickScouts();
    this.#aiTransferActivity();
    this.#maybeAiOfferForUserPlayer();
    this.#updateBoard(userResult);

    this.week++;
    if (this.week % WEEKS_PER_MONTH === 0) this.#monthlyAwards();
    if (this.week >= this.calendar.length) this.#endSeason();
    return this.lastResults;
  }

  #resultFor(pairing, userResult, knockout) {
    const isUserMatch =
      pairing.home === this.clubName || pairing.away === this.clubName;
    if (isUserMatch && userResult) return userResult;
    return simulateMatch(
      this.aiSetup(pairing.home),
      this.aiSetup(pairing.away),
      { seed: this.rng.int(0, 2 ** 31), knockout, timeline: false }
    );
  }

  #playLeagueRound(round, userResult) {
    for (const division of DIVISIONS) {
      for (const pairing of this.fixtures[division][round]) {
        const result = this.#resultFor(pairing, userResult, false);
        this.results.push({
          home: pairing.home, away: pairing.away,
          homeGoals: result.score.home, awayGoals: result.score.away,
        });
        this.#applyMatchResult(pairing, result, 'league', division);
      }
    }
  }

  #playCupRound(userResult) {
    const winners = [];
    for (const pairing of this.cup.ties) {
      const result = this.#resultFor(pairing, userResult, true);
      const winner = result.winner === 'home' ? pairing.home : pairing.away;
      winners.push(winner);
      this.cupResults.push({
        round: cupRoundName(this.cup),
        home: pairing.home, away: pairing.away,
        homeGoals: result.score.home, awayGoals: result.score.away,
        shootout: result.shootout, winner,
      });
      this.#applyMatchResult(pairing, result, 'cup');
    }
    const roundName = cupRoundName(this.cup);
    advanceCup(this.rng, this.cup, winners);
    if (this.cup.winner) {
      const prize = 750000;
      this.getClub(this.cup.winner).balance += prize;
      this.news('Cup final',
        `${this.cup.winner} lift the trophy! A £${(prize / 1000).toFixed(0)}k windfall for the winners.`);
    } else if (!inCup(this.cup, this.clubName) &&
      winners.length > 0 &&
      this.cupResults.some((r) => r.round === roundName &&
        (r.home === this.clubName || r.away === this.clubName) &&
        r.winner !== this.clubName)) {
      this.news('Out of the cup',
        `${this.clubName} exit the cup at the ${roundName} stage.`);
    }
  }

  #applyMatchResult(pairing, result, competition, division = null) {
    this.lastResults.push({
      competition,
      division,
      home: pairing.home, away: pairing.away,
      homeGoals: result.score.home, awayGoals: result.score.away,
      shootout: result.shootout ?? null,
    });

    for (const sideKey of ['home', 'away']) {
      const clubName = sideKey === 'home' ? pairing.home : pairing.away;
      const club = this.getClub(clubName);
      const conceded = sideKey === 'home' ? result.score.away : result.score.home;
      const scored = sideKey === 'home' ? result.score.home : result.score.away;
      const moraleDelta = scored > conceded ? WIN_MORALE
        : scored === conceded ? DRAW_MORALE : LOSS_MORALE;

      // Results win and lose supporters.
      const fanFactor = scored > conceded ? FAN_WIN
        : scored === conceded ? FAN_DRAW : FAN_LOSS;
      club.fanbase = Math.round(clamp(
        club.fanbase * fanFactor, FAN_MIN, club.capacity * FAN_MAX_OF_CAPACITY));

      // Rolling form guide, newest last.
      club.formGuide = [
        ...(club.formGuide ?? []),
        scored > conceded ? 'W' : scored === conceded ? 'D' : 'L',
      ].slice(-5);

      const appeared = new Set();
      for (const line of result.playerStats[sideKey]) {
        const player = club.players.find((p) => p.id === line.id);
        if (!player) continue; // defensive: roster changed mid-flight
        if (line.minutes > 0) {
          appeared.add(player.id);
          const stats = (this.seasonStats[player.id] ??= {
            apps: 0, goals: 0, assists: 0, ratingSum: 0, ratingN: 0, motm: 0,
          });
          stats.apps++;
          stats.goals += line.goals;
          stats.assists += line.assists;
          stats.ratingSum += line.rating;
          stats.ratingN++;
          const month = (this.monthly[player.id] ??= { sum: 0, n: 0 });
          month.sum += line.rating;
          month.n++;
          player.condition = Math.round(line.condition);
          player.form = Math.round((player.form * 0.6 + line.rating * 0.4) * 10) / 10;
          player.yellowsAccum += line.yellow;
          if (player.yellowsAccum >= 5) {
            player.yellowsAccum = 0;
            player.banMatches += 1;
            if (clubName === this.clubName) {
              this.news('Suspension', `${player.name} has collected five bookings and is banned for one match.`);
            }
          }
          if (line.red > 0) {
            player.banMatches += this.rng.int(1, 3);
            if (clubName === this.clubName) {
              this.news('Sent off', `${player.name} was dismissed and faces a ${player.banMatches}-match ban.`);
            }
          }
        }
        player.morale = clamp(player.morale + moraleDelta, 20, 99);
      }
      // Serving bans tick down on matchdays the player sits out.
      for (const player of club.players) {
        if (player.banMatches > 0 && !appeared.has(player.id)) player.banMatches--;
      }
    }

    // Injuries picked up in the match.
    for (const injury of result.injuries ?? []) {
      const clubName = injury.side === 'home' ? pairing.home : pairing.away;
      const found = this.getClub(clubName).players.find((p) => p.id === injury.id);
      if (found) {
        found.injuryWeeks = injury.weeks;
        if (clubName === this.clubName) {
          this.news('Injury blow',
            `${found.name} will be out for around ${injury.weeks} week${injury.weeks === 1 ? '' : 's'}.`);
        }
      }
    }

    // Gate receipts: attendance follows the fanbase, capped by the ground.
    // The user's own match already drew its gate at kickoff so the
    // matchday screen and the money always agree.
    const homeClub = this.getClub(pairing.home);
    const isUserPairing =
      pairing.home === this.clubName || pairing.away === this.clubName;
    let attendance;
    if (isUserPairing && this.userMatchAttendance != null) {
      attendance = this.userMatchAttendance;
      this.userMatchAttendance = null;
    } else {
      attendance = this.drawAttendance(homeClub, competition);
    }
    homeClub.balance += attendance * TICKET_PRICE;
    homeClub.lastAttendance = attendance;
    homeClub.attendanceSum += attendance;
    homeClub.attendanceN++;
  }

  #weeklyUpkeep() {
    for (const club of this.clubs) {
      club.balance -= club.players.reduce((sum, p) => sum + p.wage, 0);
      for (const player of club.players) {
        if (player.injuryWeeks > 0) player.injuryWeeks--;
        player.condition = clamp(player.condition + 18, 20, 100);
      }
    }
  }

  #updateBoard(userResult) {
    if (this.results.length === 0) return;
    const position = this.leaguePosition();
    const drift = clamp(this.club.expectation - position, -2, 2);
    let resultDelta = 0;
    const last = this.lastResults.find(
      (r) => r.home === this.clubName || r.away === this.clubName
    );
    if (last) {
      const scored = last.home === this.clubName ? last.homeGoals : last.awayGoals;
      const conceded = last.home === this.clubName ? last.awayGoals : last.homeGoals;
      resultDelta = scored > conceded ? 3 : scored === conceded ? 0 : -4;
    }
    this.board.confidence = clamp(this.board.confidence + drift + resultDelta, 0, 100);
    if (this.board.confidence < SACK_THRESHOLD) this.#sack();
  }

  #sack() {
    this.sacked = true;
    this.reputation = clamp(this.reputation - 12, 5, 100);
    this.#generateJobOffers();
    const offers = this.jobOffers.length
      ? ` Word is ${this.jobOffers.join(' and ')} may be interested in your services.`
      : '';
    this.news('Sacked',
      `The ${this.clubName} board have lost patience. ${this.managerName} has been relieved of his duties.${offers}`);
  }

  // --- The job market -------------------------------------------------------

  #generateJobOffers() {
    const eligible = this.clubs
      .filter((c) => c.name !== this.clubName && c.tier <= this.reputation + JOB_REACH)
      .sort((a, b) => b.tier - a.tier);
    this.jobOffers = [];
    // The two most attractive reachable clubs (with a little luck involved).
    for (const club of eligible) {
      if (this.jobOffers.length >= 2) break;
      if (this.rng.chance(0.75)) this.jobOffers.push(club.name);
    }
  }

  // Take a job from the post-sack shortlist. The career continues at the
  // new club, mid-season, with a fresh board.
  acceptJob(clubName) {
    if (!this.jobOffers.includes(clubName)) return { ok: false, reason: 'no such offer' };
    const oldClub = this.clubName;
    this.clubName = clubName;
    this.sacked = false;
    this.jobOffers = [];
    this.pendingJobOffer = null;
    this.board = { confidence: 55 };
    this.tactics = { formation: '4-4-2', mentality: 'normal' };
    this.news('A new chapter',
      `${this.managerName} leaves ${oldClub} behind and takes charge of ${clubName}.`);
    return { ok: true };
  }

  // A bigger club comes calling after a strong season.
  #maybePoachOffer() {
    const bigger = this.clubs.filter(
      (c) => c.name !== this.clubName &&
        c.tier > this.club.tier + 5 &&
        c.tier <= this.reputation + JOB_REACH
    );
    if (bigger.length === 0 || !this.rng.chance(0.4)) return;
    const suitor = bigger.sort((a, b) => b.tier - a.tier)[0];
    this.pendingJobOffer = { club: suitor.name, season: this.seasonIndex };
    this.news('An offer from above',
      `${suitor.name} want you as their new manager. Accept from the Club & Board screen.`,
      { jobOffer: suitor.name });
  }

  respondToJobOffer(accept) {
    const offer = this.pendingJobOffer;
    if (!offer) return { ok: false, reason: 'no offer on the table' };
    this.pendingJobOffer = null;
    if (!accept) {
      this.news('Loyalty', `You turn down ${offer.club}. The ${this.clubName} faithful approve.`);
      this.board.confidence = clamp(this.board.confidence + 5, 0, 100);
      return { ok: true, accepted: false };
    }
    const oldClub = this.clubName;
    this.clubName = offer.club;
    this.board = { confidence: 60 };
    this.tactics = { formation: '4-4-2', mentality: 'normal' };
    this.jobOffers = [];
    this.news('A step up',
      `${this.managerName} swaps ${oldClub} for ${offer.club}. Big shoes to fill.`);
    return { ok: true, accepted: true };
  }

  #monthlyAwards() {
    let best = null;
    for (const [id, m] of Object.entries(this.monthly)) {
      if (m.n >= 2) {
        const avg = m.sum / m.n;
        if (!best || avg > best.avg) best = { id, avg };
      }
    }
    if (best) {
      const found = this.findPlayer(best.id);
      if (found) {
        this.news(`Player of the Month`,
          `${found.player.name} (${found.club?.name ?? 'free agent'}) is ${monthName(this.week - 1)}'s ` +
          `Player of the Month with an average rating of ${best.avg.toFixed(1)}.`);
      }
    }
    this.monthly = {};
  }

  // --- Scouting & attribute masking -----------------------------------------

  // Do we know this player's exact attributes?
  knowsExactly(player) {
    if (this.scouted[player.id]) return true;
    return this.club.players.some((p) => p.id === player.id);
  }

  // What the manager can see of a player's attribute: an exact number for
  // own or scouted players, otherwise a stable range containing the truth.
  attrDisplay(player, attr) {
    if (this.knowsExactly(player)) return { exact: player[attr] };
    // A deterministic per-player offset keeps the range stable across
    // views and sessions without leaking the true value at its centre.
    const offset = (hashString(`${player.id}:${attr}`) % (MASK_HALF_WIDTH - 1)) -
      Math.floor((MASK_HALF_WIDTH - 1) / 2);
    const centre = player[attr] + offset;
    const lo = Math.max(1, Math.min(centre - MASK_HALF_WIDTH, player[attr]));
    const hi = Math.min(99, Math.max(centre + MASK_HALF_WIDTH, player[attr]));
    return { lo, hi };
  }

  // Midpoint of what's visible — used for sorting without leaking truth.
  visibleMid(player, attr) {
    const d = this.attrDisplay(player, attr);
    return d.exact ?? (d.lo + d.hi) / 2;
  }

  scoutPlayer(playerId) {
    if (this.scouted[playerId]) return { ok: false, reason: 'already scouted' };
    if (this.pendingScouts.some((s) => s.playerId === playerId)) {
      return { ok: false, reason: 'scout already dispatched' };
    }
    const found = this.findPlayer(playerId);
    if (!found) return { ok: false, reason: 'unknown player' };
    if (this.club.balance < SCOUT_FEE) return { ok: false, reason: 'cannot afford the fee' };
    this.club.balance -= SCOUT_FEE;
    this.pendingScouts.push({ playerId, weeksLeft: 1 });
    return { ok: true, fee: SCOUT_FEE };
  }

  #tickScouts() {
    const done = [];
    for (const s of this.pendingScouts) {
      s.weeksLeft--;
      if (s.weeksLeft <= 0) done.push(s.playerId);
    }
    this.pendingScouts = this.pendingScouts.filter((s) => s.weeksLeft > 0);
    for (const id of done) {
      this.scouted[id] = true;
      const found = this.findPlayer(id);
      if (found) {
        this.news('Scout report filed',
          `${found.player.name} (${found.club?.name ?? 'free agent'}): ` +
          `attacking ${found.player.atk}, defending ${found.player.def}. Full profile on the transfer screen.`);
      }
    }
  }

  // A scouting card on any club: position, form, and the XI they are
  // likely to field this week.
  oppositionReport(clubName) {
    const club = this.getClub(clubName);
    if (!club) return null;
    const { starters } = selectXI(club.players, '4-4-2');
    const dangerMan = starters
      .map((s) => s.player)
      .filter((p) => p.pos !== 'GK')
      .reduce((best, p) =>
        (ability(p) + p.form * 2 > ability(best) + best.form * 2 ? p : best));
    return {
      club: club.name,
      division: club.division,
      position: this.leaguePosition(clubName),
      form: club.formGuide ?? [],
      xi: starters,
      dangerMan,
    };
  }

  // --- Stadium expansion ----------------------------------------------------

  // What expanding would look like for a club right now.
  expansionQuote(club = this.club) {
    const seats = Math.max(1000, Math.round((club.capacity * EXPANSION_STEP) / 500) * 500);
    const cost = seats * EXPANSION_COST_PER_SEAT;
    return {
      seats,
      cost,
      active: club.expansion ?? null,
      canAfford: club.balance >= cost,
      demandOk: club.fanbase >= club.capacity * EXPANSION_DEMAND,
    };
  }

  // Ask the board to expand the user's stadium.
  requestExpansion() {
    const club = this.club;
    const quote = this.expansionQuote(club);
    if (quote.active) return { ok: false, reason: 'builders are already in' };
    if (!quote.demandOk) {
      return { ok: false, reason: 'the board see empty seats — grow the fanbase first' };
    }
    if (!quote.canAfford) return { ok: false, reason: 'the club cannot afford it' };
    club.balance -= quote.cost;
    club.expansion = { seats: quote.seats, weeksLeft: EXPANSION_WEEKS };
    this.news('Stadium expansion approved',
      `Work begins on ${quote.seats.toLocaleString()} new seats ` +
      `(£${quote.cost.toLocaleString()}, ready in ${EXPANSION_WEEKS} weeks).`);
    return { ok: true, ...quote };
  }

  #tickExpansions() {
    for (const club of this.clubs) {
      if (!club.expansion) continue;
      club.expansion.weeksLeft--;
      if (club.expansion.weeksLeft <= 0) {
        club.capacity += club.expansion.seats;
        const seats = club.expansion.seats;
        club.expansion = null;
        if (club.name === this.clubName) {
          this.news('Stadium expansion complete',
            `${seats.toLocaleString()} new seats open. ${club.name}'s ground now holds ${club.capacity.toLocaleString()}.`);
        }
      }
    }
  }

  // AI boards expand when the ground is genuinely bursting.
  #aiExpansions() {
    for (const club of this.clubs) {
      if (club.name === this.clubName || club.expansion) continue;
      const quote = this.expansionQuote(club);
      if (club.fanbase >= club.capacity * 1.1 && club.balance >= quote.cost * 1.5) {
        club.balance -= quote.cost;
        club.expansion = { seats: quote.seats, weeksLeft: EXPANSION_WEEKS };
      }
    }
  }

  // --- Transfers --------------------------------------------------------------

  searchPlayers({ pos = null, maxValue = null, minAbility = 0 } = {}) {
    const rows = [];
    for (const club of this.clubs) {
      if (club.name === this.clubName) continue;
      for (const player of club.players) {
        if (pos && player.pos !== pos) continue;
        if (maxValue && player.value > maxValue) continue;
        if (ability(player) < minAbility) continue;
        rows.push({ player, club: club.name, asking: askingPrice(club, player) });
      }
    }
    for (const player of this.freeAgents) {
      if (pos && player.pos !== pos) continue;
      if (ability(player) < minAbility) continue;
      rows.push({ player, club: null, asking: 0 });
    }
    // Sort by what the manager can actually see, not the hidden truth.
    const visible = (p) =>
      p.pos === 'GK' ? this.visibleMid(p, 'def')
        : (this.visibleMid(p, 'atk') + this.visibleMid(p, 'def')) / 2;
    return rows.sort((a, b) => visible(b.player) - visible(a.player));
  }

  // Bid for a player at another club. Synchronous negotiation.
  bid(playerId, amount) {
    const found = this.findPlayer(playerId);
    if (!found) return { status: 'rejected', reason: 'unknown player' };
    const { player, club } = found;
    if (club?.name === this.clubName) return { status: 'rejected', reason: 'already yours' };

    if (club === null) return this.#signFreeAgent(player);

    if (amount > this.club.transferBudget) {
      return { status: 'rejected', reason: 'beyond your transfer budget' };
    }
    const verdict = evaluateBid(club, player, amount);
    if (verdict.status !== 'accepted') return verdict;

    if (!playerAgrees(this.rng, player, club.tier, this.club.tier)) {
      return { status: 'rejected', reason: `${player.name} does not want the move` };
    }
    const wage = wageDemand(player, club.tier, this.club.tier);
    this.#completeTransfer(player, club, this.club, amount, wage);
    return { status: 'accepted', wage };
  }

  #signFreeAgent(player) {
    const wage = freeAgentWage(player);
    this.freeAgents = this.freeAgents.filter((p) => p.id !== player.id);
    player.wage = wage;
    player.contractYears = 2;
    player.morale = 75;
    this.club.players.push(player);
    this.news('Free transfer',
      `${player.name} joins ${this.clubName} on a free, earning £${wage.toLocaleString()}/week.`);
    return { status: 'accepted', wage, free: true };
  }

  #completeTransfer(player, from, to, fee, wage) {
    from.players = from.players.filter((p) => p.id !== player.id);
    from.balance += fee;
    to.balance -= fee;
    if (to.name === this.clubName) {
      this.club.transferBudget = Math.max(0, this.club.transferBudget - fee);
    }
    player.wage = wage;
    player.contractYears = 3;
    player.morale = 80;
    player.listed = false;
    to.players.push(player);
    this.news('Transfer',
      `${player.name} joins ${to.name} from ${from.name} for £${fee.toLocaleString()}.`);
  }

  toggleTransferList(playerId) {
    const player = this.club.players.find((p) => p.id === playerId);
    if (!player) return;
    player.listed = !player.listed;
    if (player.listed) player.morale = clamp(player.morale - 10, 20, 99);
  }

  renewContract(playerId) {
    const player = this.club.players.find((p) => p.id === playerId);
    if (!player) return { ok: false };
    const wage = Math.round((wageDemand(player, this.club.tier, this.club.tier) * 1.05) / 10) * 10;
    player.wage = wage;
    player.contractYears = 3;
    player.morale = clamp(player.morale + 8, 20, 99);
    this.news('Contract signed', `${player.name} signs a new 3-year deal at £${wage.toLocaleString()}/week.`);
    return { ok: true, wage };
  }

  // AI offers for user players arrive as pending decisions.
  #maybeAiOfferForUserPlayer() {
    if (!this.rng.chance(0.22)) return;
    const buyers = this.clubs.filter((c) => c.name !== this.clubName);
    const buyer = this.rng.pick(buyers);
    const targets = this.club.players
      .map((p) => ({ p, interest: aiInterest(buyer, p) * (p.listed ? 2.5 : 1) }))
      .filter((t) => t.interest > 0.15);
    if (targets.length === 0) return;
    const target = this.rng.weightedPick(
      targets.map((t) => ({ item: t.p, weight: t.interest }))
    );
    if (this.pendingOffers.some((o) => o.playerId === target.id)) return;
    const amount = aiOfferAmount(this.rng, target);
    if (amount > buyer.balance) return;
    const offer = {
      id: this.nextOfferId++,
      playerId: target.id,
      player: target.name,
      from: buyer.name,
      amount,
      week: this.week,
    };
    this.pendingOffers.push(offer);
    this.news('Transfer offer',
      `${buyer.name} have offered £${amount.toLocaleString()} for ${target.name}.`,
      { offerId: offer.id });
  }

  respondToOffer(offerId, accept) {
    const idx = this.pendingOffers.findIndex((o) => o.id === offerId);
    if (idx === -1) return { ok: false, reason: 'offer expired' };
    const offer = this.pendingOffers.splice(idx, 1)[0];
    if (!accept) {
      this.news('Offer rejected', `You turned down ${offer.from}'s bid for ${offer.player}.`);
      return { ok: true, accepted: false };
    }
    const player = this.club.players.find((p) => p.id === offer.playerId);
    const buyer = this.getClub(offer.from);
    if (!player || !canRelease(this.club, player)) {
      return { ok: false, reason: 'squad too thin to sell' };
    }
    const wage = wageDemand(player, this.club.tier, buyer.tier);
    this.#completeTransfer(player, this.club, buyer, offer.amount, wage);
    this.club.transferBudget += Math.round(offer.amount * 0.7);
    return { ok: true, accepted: true };
  }

  // Occasional AI-to-AI transfers keep the world alive.
  #aiTransferActivity() {
    if (!this.rng.chance(0.15)) return;
    const others = this.clubs.filter((c) => c.name !== this.clubName);
    const buyer = this.rng.pick(others);
    const sellers = others.filter((c) => c.name !== buyer.name);
    const seller = this.rng.pick(sellers);
    const targets = seller.players
      .map((p) => ({ p, interest: aiInterest(buyer, p) }))
      .filter((t) => t.interest > 0.2 && canRelease(seller, t.p));
    if (targets.length === 0) return;
    const target = this.rng.weightedPick(
      targets.map((t) => ({ item: t.p, weight: t.interest }))
    );
    const fee = askingPrice(seller, target);
    if (fee > buyer.balance * 0.5) return;
    this.#completeTransfer(target, seller, buyer, fee,
      wageDemand(target, seller.tier, buyer.tier));
  }

  // --- Season end ---------------------------------------------------------------

  #prizeMoney(position, division) {
    const size = this.divisionClubs(division).length;
    const base = (size + 1 - position) * (division === 1 ? 120000 : 45000);
    return position === 1 ? base + (division === 1 ? 500000 : 200000) : base;
  }

  #endSeason() {
    const finalTables = {};
    for (const d of DIVISIONS) finalTables[d] = this.divisionTable(d);
    const champion = finalTables[1][0].team;
    const champion2 = finalTables[2][0].team;
    const position = this.leaguePosition();
    const userDivision = this.club.division;

    for (const d of DIVISIONS) {
      for (const [i, row] of finalTables[d].entries()) {
        const club = this.getClub(row.team);
        club.balance += this.#prizeMoney(i + 1, d);
        // A strong finish captures the town's imagination; a poor one
        // empties the terraces a little. Fresh turnstile stats next year.
        const pull = 1 + (6.5 - (i + 1)) * 0.006;
        club.fanbase = Math.round(clamp(
          club.fanbase * pull, FAN_MIN, club.capacity * FAN_MAX_OF_CAPACITY));
        club.attendanceSum = 0;
        club.attendanceN = 0;
      }
    }

    // Two up, two down.
    const relegated = finalTables[1].slice(-2).map((r) => r.team);
    const promoted = finalTables[2].slice(0, 2).map((r) => r.team);
    for (const name of relegated) this.getClub(name).division = 2;
    for (const name of promoted) this.getClub(name).division = 1;
    this.news('Promotion and relegation',
      `${promoted.join(' and ')} go up. ${relegated.join(' and ')} drop to Division 2.`);
    if (promoted.includes(this.clubName)) {
      this.news('PROMOTED!', `${this.clubName} are a Division 1 club! The town is buzzing.`);
    } else if (relegated.includes(this.clubName)) {
      this.news('Relegated', `${this.clubName} slip into Division 2. A long road back starts now.`);
    }

    // Awards.
    let topScorer = null;
    let bestPlayer = null;
    for (const [id, s] of Object.entries(this.seasonStats)) {
      if (!topScorer || s.goals > this.seasonStats[topScorer]?.goals) topScorer = id;
      const avg = s.ratingN >= 10 ? s.ratingSum / s.ratingN : 0;
      if (avg > 0 && (!bestPlayer || avg > bestPlayer.avg)) bestPlayer = { id, avg };
    }
    const scorerInfo = topScorer ? this.findPlayer(topScorer) : null;
    const bestInfo = bestPlayer ? this.findPlayer(bestPlayer.id) : null;

    this.history.push({
      season: this.seasonIndex,
      champion,
      champion2,
      promoted,
      relegated,
      userPosition: position,
      userDivision,
      cupWinner: this.cup.winner,
      topScorer: scorerInfo
        ? { name: scorerInfo.player.name, club: scorerInfo.club?.name, goals: this.seasonStats[topScorer].goals }
        : null,
      playerOfSeason: bestInfo
        ? { name: bestInfo.player.name, club: bestInfo.club?.name, avg: Math.round(bestPlayer.avg * 10) / 10 }
        : null,
    });

    this.news('Season review',
      `${champion} are champions; ${champion2} win Division 2. ` +
      `${this.clubName} finished ${this.ordinal(position)} in Division ${userDivision}.` +
      (scorerInfo ? ` Golden boot: ${scorerInfo.player.name} (${this.seasonStats[topScorer].goals} goals).` : '') +
      (bestInfo ? ` Player of the season: ${bestInfo.player.name} (${bestPlayer.avg.toFixed(1)}).` : ''));

    // Board verdict and managerial standing.
    const verdict = this.club.expectation - position;
    this.board.confidence = clamp(this.board.confidence + verdict * 6, 0, 100);
    let repDelta = verdict * 2;
    if (champion === this.clubName) repDelta += 12;
    if (this.cup.winner === this.clubName) repDelta += 8;
    if (promoted.includes(this.clubName)) repDelta += 8;
    if (relegated.includes(this.clubName)) repDelta -= 8;
    this.reputation = clamp(this.reputation + repDelta, 5, 100);

    if (position > this.club.expectation + 3 && this.board.confidence < 40) {
      this.news('The axe falls',
        `A ${this.ordinal(position)}-place finish was not what the board demanded.`);
      this.#sack();
    } else if (repDelta > 0) {
      this.#maybePoachOffer();
    }

    // Development, retirements, contracts.
    for (const club of this.clubs) {
      const retained = [];
      for (const player of club.players) {
        const retires = developPlayer(this.rng, player);
        if (retires) {
          if (club.name === this.clubName) {
            this.news('Retirement', `${player.name} hangs up his boots at ${player.age}.`);
          }
          continue;
        }
        if (player.contractYears === 0) {
          // AI clubs retain their better players; others go free.
          const isUser = club.name === this.clubName;
          const keep = isUser
            ? false // the user must renew deliberately, pre-warned via news
            : this.rng.chance(0.7);
          if (keep) {
            player.contractYears = this.rng.int(1, 3);
            player.wage = Math.round((player.wage * 1.08) / 10) * 10;
          } else {
            if (isUser) {
              this.news('Out of contract', `${player.name} leaves ${club.name} on a free.`);
            }
            player.contractYears = 0;
            this.freeAgents.push(player);
            continue;
          }
        }
        retained.push(player);
      }
      club.players = retained;

      // Youth intake keeps squads viable.
      while (club.players.length < 16) {
        club.players.push(this.#youthPlayer(club));
      }
      club.transferBudget = Math.max(club.transferBudget, Math.round(club.balance * 0.4));
    }
    this.freeAgents = this.freeAgents.slice(-40);

    // Warn about expiring contracts for next season.
    for (const player of this.club.players.filter((p) => p.contractYears === 1)) {
      this.news('Contract expiring', `${player.name} is in the final year of his deal. Consider renewing.`);
    }

    this.#aiExpansions();

    // Board expectations track each club's stature within its division.
    for (const d of DIVISIONS) {
      const ranked = [...this.divisionClubs(d)]
        .sort((a, b) => overallRating(b) - overallRating(a));
      ranked.forEach((club, rank) => {
        club.expectation = Math.min(Math.max(2, rank + 1), ranked.length);
      });
    }

    // Reset for the new season.
    this.seasonIndex++;
    this.week = 0;
    this.results = [];
    this.cupResults = [];
    this.fixtures = this.#generateAllFixtures();
    this.cup = createCup(this.rng, this.clubs.map((c) => c.name));
    this.seasonStats = emptySeasonStats();
    this.monthly = {};
    this.pendingOffers = [];
    this.news(`Season ${this.seasonIndex + 1} begins`,
      `A new campaign kicks off in Division ${this.club.division}. ` +
      `The board expect ${this.ordinal(this.club.expectation)} or better.`);
  }

  #youthPlayer(club) {
    const rng = this.rng;
    const pos = rng.pick(['DF', 'DF', 'MF', 'MF', 'FW', 'GK']);
    const base = club.tier - rng.int(12, 24);
    const spread = () => Math.max(20, base + rng.int(-5, 8));
    const weak = () => Math.max(15, base - rng.int(10, 25));
    const taken = new Set(club.players.map((p) => p.name));
    let name;
    do {
      name = `${rng.pick(FIRST_NAMES)} ${rng.pick(LAST_NAMES)}`;
    } while (taken.has(name));
    const player = {
      id: `${club.shortName}-Y${++this.youthSeq}`,
      name,
      pos,
      atk: pos === 'FW' || pos === 'MF' ? spread() : weak(),
      def: pos === 'GK' || pos === 'DF' || pos === 'MF' ? spread() : weak(),
      age: rng.int(17, 18),
      consistency: rng.int(25, 70),
      injuryProne: rng.int(10, 80),
      contractYears: 3,
      condition: 100,
      form: 6.0,
      morale: 75,
      injuryWeeks: 0,
      banMatches: 0,
      yellowsAccum: 0,
      wage: 250,
      value: 50000,
    };
    return player;
  }

  // --- Tactics & persistence ---------------------------------------------------

  setTactics({ formation, mentality }) {
    if (formation && !FORMATIONS[formation]) throw new Error(`unknown formation ${formation}`);
    if (mentality && !MENTALITIES.includes(mentality)) throw new Error(`unknown mentality ${mentality}`);
    if (formation) this.tactics.formation = formation;
    if (mentality) this.tactics.mentality = mentality;
  }

  serialize() {
    return JSON.stringify({
      version: this.version,
      managerName: this.managerName,
      clubName: this.clubName,
      rngState: this.rng.getState(),
      clubs: this.clubs,
      freeAgents: this.freeAgents,
      seasonIndex: this.seasonIndex,
      week: this.week,
      calendar: this.calendar,
      fixtures: this.fixtures,
      results: this.results,
      cup: this.cup,
      cupResults: this.cupResults,
      seasonStats: this.seasonStats,
      monthly: this.monthly,
      inbox: this.inbox,
      pendingOffers: this.pendingOffers,
      nextOfferId: this.nextOfferId,
      board: this.board,
      tactics: this.tactics,
      history: this.history,
      youthSeq: this.youthSeq,
      sacked: this.sacked,
      reputation: this.reputation,
      jobOffers: this.jobOffers,
      pendingJobOffer: this.pendingJobOffer,
      scouted: this.scouted,
      pendingScouts: this.pendingScouts,
    });
  }

  static restore(json) {
    const data = typeof json === 'string' ? JSON.parse(json) : json;
    if (data.version !== SAVE_VERSION) throw new Error('incompatible save version');
    // Construct a real instance (private methods need the class brand),
    // then overwrite every field with the saved state.
    const game = new Game({
      managerName: data.managerName,
      clubName: data.clubName,
      seed: 0,
    });
    const { rngState, ...fields } = data;
    Object.assign(game, fields);
    game.rng.setState(rngState);
    game.lastResults = [];
    return game;
  }
}

export { cupRoundName, cupRoundNames, inCup };
