// Match simulation engine.
//
// MatchSim plays a match one minute at a time so a UI can pause, watch, and
// make substitutions mid-match. simulateMatch() wraps it for one-shot use.
//
// Setups accept either a full squad (best XI + bench selected automatically),
// an explicit XI ({ name, players: [11] }), or a prepared lineup
// ({ name, starters: [{player, slot}], bench, formation, mentality }).
//
// The engine models: possession from the midfield battle, chance creation
// and shot resolution, fouls and cards, in-match injuries with forced
// substitutions, tactical auto-subs, live per-player ratings and stats,
// condition decay, mentality and out-of-position effects, and — for
// knockout ties — extra time and a penalty shootout.
//
// All randomness comes from a single seeded RNG, so the same seed always
// produces the identical match. The engine never mutates the player
// objects it is given; per-match state lives in the stat lines.

import { createRng } from './rng.js';
import {
  validateTeam, selectXI, familiarity, FORMATIONS, MENTALITIES,
  POSITIONS, DETAILED_POSITIONS, UNIT_OF, unitOf, ATTR_MIN, ATTR_MAX,
} from './team.js';
import { attrOf, unitContribution } from './players.js';

const HOME_ADVANTAGE = 1.12; // multiplier on home midfield/attack effectiveness
const BASE_CHANCE_PROB = 0.28; // chance of a shot in an attacking minute
const MAX_SUBS = 3;

const BASE_RATING = 6.0;
const RATING = {
  pass: 0.008,
  tackle: 0.06,
  shotOnTarget: 0.15,
  shotOff: -0.04,
  goal: 1.1,
  assist: 0.6,
  save: 0.18,
  concedeGk: -0.3,
  concedeDf: -0.1,
  foul: -0.05,
  yellow: -0.25,
  red: -1.3,
  cleanSheet: 0.5,
  penScored: 0.35,
  penMissed: -0.45,
};

const MENTALITY_MODS = {
  defensive: { create: 0.85, concede: 0.9 },
  normal: { create: 1, concede: 1 },
  attacking: { create: 1.12, concede: 1.08 },
};

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

const COMMENTARY = {
  chanceBuild: [
    '{player} finds space on the edge of the box',
    '{team} work it wide and whip in a cross',
    'A slick one-two opens up the {opponent} defence',
    '{player} drives at the back line',
  ],
  goal: [
    'GOAL! {player} buries it! {team} strike!',
    'GOAL! {player} finishes coolly past the keeper!',
    'GOAL! A thumping strike from {player}!',
    'GOAL! {player} rises highest and heads it home!',
  ],
  save: [
    '{player} shoots... brilliant save by the keeper!',
    'The keeper gets down well to deny {player}',
    '{player} tests the goalkeeper, who holds on',
  ],
  miss: [
    '{player} drags the shot wide',
    '{player} blazes it over the bar',
    'So close! {player} clips the outside of the post',
  ],
  block: [
    "{player}'s effort is blocked by a desperate lunge",
    "A defender throws himself in front of {player}'s shot",
  ],
  corner: ['Corner to {team}', '{team} win a corner'],
  foul: [
    '{player} is penalised for a late challenge',
    'Free kick — {player} catches his man',
    '{player} brings down his opponent',
  ],
  yellow: ['{player} goes into the book', 'Yellow card for {player}'],
  red: [
    'RED CARD! {player} is sent off!',
    '{player} sees red — {team} are down to {count} men!',
  ],
  injury: [
    '{player} is down and holding his leg — he cannot continue',
    'Bad news: {player} pulls up and signals to the bench',
  ],
};

function fill(template, ctx) {
  return template.replace(/\{(\w+)\}/g, (_, key) => ctx[key] ?? '');
}

const pid = (p) => p.id ?? p.name;

function newLine(player, slot, started) {
  return {
    id: pid(player),
    name: player.name,
    pos: player.pos,
    slot,
    started,
    minutes: 0,
    rating: BASE_RATING,
    passes: 0,
    tackles: 0,
    shots: 0,
    onTarget: 0,
    goals: 0,
    assists: 0,
    saves: 0,
    fouls: 0,
    yellow: 0,
    red: 0,
    condition: player.condition ?? 100,
  };
}

function normalizeSetup(raw) {
  if (!raw || typeof raw !== 'object') return { error: 'setup is not an object' };
  if (raw.starters) {
    return {
      name: raw.name,
      shortName: raw.shortName ?? raw.name,
      starters: raw.starters.map((s) => ({ player: s.player, slot: s.slot })),
      bench: raw.bench ?? [],
      formation: raw.formation ?? '4-4-2',
      mentality: raw.mentality ?? 'normal',
    };
  }
  if (Array.isArray(raw.players) && raw.players.length > 11) {
    const picked = selectXI(raw.players, raw.formation ?? '4-4-2');
    return {
      name: raw.name,
      shortName: raw.shortName ?? raw.name,
      starters: picked.starters,
      bench: picked.bench,
      formation: picked.formation,
      mentality: raw.mentality ?? 'normal',
    };
  }
  return {
    name: raw.name,
    shortName: raw.shortName ?? raw.name,
    starters: (raw.players ?? []).map((p) => ({ player: p, slot: p?.position ?? p?.pos })),
    bench: raw.bench ?? [],
    formation: raw.formation ?? '4-4-2',
    mentality: raw.mentality ?? 'normal',
  };
}

function validateSetup(setup) {
  if (setup.error) return [setup.error];
  const xi = { name: setup.name, players: setup.starters.map((s) => s.player ?? {}) };
  const errors = validateTeam(xi).filter((e) => !e.includes('exactly 1 GK'));
  const gkSlots = setup.starters.filter((s) => unitOf(s.slot) === 'GK').length;
  if (gkSlots !== 1) errors.push(`expected exactly 1 GK, got ${gkSlots}`);
  for (const s of setup.starters) {
    if (s.player && !POSITIONS.includes(s.slot) && !DETAILED_POSITIONS.includes(s.slot)) {
      errors.push(`${s.player.name}: invalid slot ${s.slot}`);
    }
  }
  for (const b of setup.bench) {
    for (const attr of ['atk', 'def']) {
      if (!Number.isFinite(b[attr]) || b[attr] < ATTR_MIN || b[attr] > ATTR_MAX) {
        errors.push(`${b.name}: ${attr} out of range (${b[attr]})`);
      }
    }
  }
  return errors;
}

const PASS_WEIGHT = { GK: 0.4, DF: 2, MF: 3, FW: 1.5 };
const TACKLE_WEIGHT = { DF: 3, MF: 2, FW: 0.5 };
const ASSIST_WEIGHT = { DF: 0.5, MF: 2, FW: 1.5 };
const SHOOT_WEIGHT = { DF: 0.3, MF: 1, FW: 3 };

export class MatchSim {
  constructor(home, away, options = {}) {
    const homeSetup = normalizeSetup(home);
    const awaySetup = normalizeSetup(away);
    const homeErrors = validateSetup(homeSetup);
    if (homeErrors.length > 0) throw new Error(`invalid home team: ${homeErrors.join('; ')}`);
    const awayErrors = validateSetup(awaySetup);
    if (awayErrors.length > 0) throw new Error(`invalid away team: ${awayErrors.join('; ')}`);

    this.seed = options.seed ?? Math.floor(Math.random() * 2 ** 32);
    this.rng = createRng(this.seed);
    this.knockout = options.knockout ?? false;
    this.trackTimeline = options.timeline ?? true;
    // Dev/test hook: called as phaseHook(name, ctx) after each minute phase.
    // Observational only — a hook that draws from ctx.rng breaks replay.
    this.phaseHook = options.phaseHook ?? null;
    const useHomeAdvantage = options.homeAdvantage ?? true;
    const autoSubs = options.autoSubs ?? {};

    this.sides = {
      home: this.#makeSide(homeSetup, useHomeAdvantage ? HOME_ADVANTAGE : 1, autoSubs.home ?? true),
      away: this.#makeSide(awaySetup, 1, autoSubs.away ?? true),
    };
    this.score = { home: 0, away: 0 };
    this.events = [];
    this.timeline = [];
    this.injuries = [];
    this.minute = 0;
    this.stoppage = this.rng.int(1, 5);
    this.regulationEnd = 90 + this.stoppage;
    this.finalMinute = this.regulationEnd;
    this.inExtraTime = false;
    this.finished = false;
    this.shootout = null;

    this.#log(1, 'kickoff', null, null,
      `${homeSetup.name} v ${awaySetup.name} — we are under way!`);
  }

  #makeSide(setup, boost, autoSubs) {
    const lines = new Map();
    const sharpness = new Map();
    for (const { player, slot } of setup.starters) {
      lines.set(pid(player), newLine(player, slot, true));
    }
    for (const b of setup.bench) lines.set(pid(b), newLine(b, b.pos, false));
    for (const p of [...setup.starters.map((s) => s.player), ...setup.bench]) {
      const consistency = p.consistency ?? 70;
      const noise = (this.rng.next() - 0.5) * 2 * (1 - consistency / 99) * 0.14;
      const morale = p.morale ?? 70;
      const form = p.form ?? 6;
      sharpness.set(pid(p), clamp(1 + (morale - 70) * 0.001 + (form - 6) * 0.02 + noise, 0.75, 1.2));
    }
    return {
      setup,
      boost,
      autoSubs,
      onPitch: setup.starters.map((s) => ({ player: s.player, slot: s.slot })),
      benchLeft: [...setup.bench],
      subsUsed: 0,
      lines,
      sharpness,
      slotCounts: { GK: 1, ...Object.fromEntries(['DF', 'MF', 'FW'].map((u) => [
        u, setup.starters.filter((s) => unitOf(s.slot) === u).length,
      ])) },
      yellowCarded: new Set(),
      sentOff: new Set(),
      stats: {
        possession: 0, shots: 0, onTarget: 0, corners: 0,
        fouls: 0, yellowCards: 0, redCards: 0,
      },
      possessionMinutes: 0,
      scorers: [],
    };
  }

  // Events carry both display text and a machine-readable data payload
  // (ids, not names) so consumers never have to parse commentary strings.
  #log(minute, type, sideKey, player, text, data = {}) {
    const e = { minute, type, side: sideKey, player: player?.name ?? null, text, data };
    this.events.push(e);
    this.turnEvents?.push(e);
  }

  #line(side, player) {
    return side.lines.get(pid(player));
  }

  #rate(side, player, delta) {
    const l = this.#line(side, player);
    l.rating = clamp(l.rating + delta, 1, 10);
  }

  // Effective contribution of an on-pitch entry given a base skill value
  // (an attribute or blend): scaled by familiarity, sharpness, condition.
  #eff(side, entry, base) {
    const line = this.#line(side, entry.player);
    const conditionFactor = 0.7 + 0.3 * (line.condition / 100);
    return base * familiarity(entry.player, entry.slot) *
      side.sharpness.get(pid(entry.player)) * conditionFactor;
  }

  // Unit strength averaged over the kickoff slot count, so sendings off
  // and unreplaced injuries genuinely weaken the side. Each unit reads
  // the attributes that should drive it (EE-3, unitContribution).
  #unit(side, unit) {
    const entries = side.onPitch.filter((e) => unitOf(e.slot) === unit);
    if (unit === 'GK') {
      if (entries.length === 0) return 5;
      return this.#eff(side, entries[0], unitContribution(entries[0].player, 'GK'));
    }
    const total = entries.reduce(
      (sum, e) => sum + this.#eff(side, e, unitContribution(e.player, unit)), 0);
    return Math.max(5, total / Math.max(1, side.slotCounts[unit]));
  }

  // Numbers matter as well as quality: packing a unit strengthens it
  // (with diminishing returns) relative to the 4-4-2 baseline. Midfield
  // headcount moves possession only gently — otherwise the possession
  // channel drowns out the defensive/attacking intent of a shape.
  #headcount(side, unit, baseline, exponent) {
    return (side.slotCounts[unit] / baseline) ** exponent;
  }

  #strength(side, kind) {
    if (kind === 'midfield') {
      return this.#unit(side, 'MF') * this.#headcount(side, 'MF', 4, 0.25) * side.boost;
    }
    if (kind === 'attack') {
      return (
        0.8 * this.#unit(side, 'FW') * this.#headcount(side, 'FW', 2, 0.5) +
        0.2 * this.#unit(side, 'MF')
      ) * side.boost;
    }
    if (kind === 'defense') {
      return 0.8 * this.#unit(side, 'DF') * this.#headcount(side, 'DF', 4, 0.5) +
        0.2 * this.#unit(side, 'MF');
    }
    return this.#unit(side, 'GK');
  }

  // weights and slots are unit-level; on-pitch slots may be detailed.
  #pick(side, weights, slots) {
    const pool = side.onPitch.filter((e) => slots.includes(unitOf(e.slot)));
    if (pool.length === 0) return null;
    return this.rng.weightedPick(pool.map((e) => ({ item: e, weight: weights[unitOf(e.slot)] ?? 1 })));
  }

  #removeFromPitch(side, player) {
    side.onPitch = side.onPitch.filter((e) => pid(e.player) !== pid(player));
  }

  // Public: change formation and/or mentality mid-match.
  // Outfield players are re-mapped to the new shape, preferring their
  // natural positions; with men sent off, the deficit lands up front.
  setTactics(sideKey, { formation, mentality } = {}) {
    const side = this.sides[sideKey];
    if (!side) return { ok: false, error: 'unknown side' };
    if (this.finished) return { ok: false, error: 'match is over' };
    if (mentality && !MENTALITIES.includes(mentality)) {
      return { ok: false, error: `unknown mentality: ${mentality}` };
    }
    if (formation && !FORMATIONS[formation]) {
      return { ok: false, error: `unknown formation: ${formation}` };
    }

    const changes = [];
    if (mentality && mentality !== side.setup.mentality) {
      side.setup.mentality = mentality;
      changes.push(mentality);
    }
    if (formation && formation !== side.setup.formation) {
      side.setup.formation = formation;
      const shape = FORMATIONS[formation];
      const keeper = side.onPitch.filter((e) => unitOf(e.slot) === 'GK');
      let outfield = side.onPitch.filter((e) => unitOf(e.slot) !== 'GK');

      // Fill defence first, then midfield, then attack, preferring
      // players natural in each unit; within a unit, the shape's detailed
      // slots go to the most familiar players.
      const remapped = [];
      for (const unit of ['DF', 'MF', 'FW']) {
        const unitSlots = shape.slots
          .filter((s) => UNIT_OF[s.pos] === unit)
          .map((s) => s.pos);
        const naturals = outfield.filter((e) => e.player.pos === unit);
        const attr = unit === 'DF' ? 'def' : unit === 'FW' ? 'atk' : null;
        const score = (e) => (attr ? e.player[attr] : (e.player.atk + e.player.def) / 2);
        const picked = [
          ...naturals.sort((a, b) => score(b) - score(a)),
          ...outfield.filter((e) => e.player.pos !== unit).sort((a, b) => score(b) - score(a)),
        ].slice(0, Math.min(unitSlots.length, outfield.length));
        const unassigned = [...picked];
        for (const slotPos of unitSlots) {
          if (unassigned.length === 0) break;
          const better = (a, b) => {
            const fa = familiarity(a.player, slotPos);
            const fb = familiarity(b.player, slotPos);
            return fb > fa || (fb === fa && score(b) > score(a)) ? b : a;
          };
          const entry = unassigned.reduce((a, b) => better(a, b));
          unassigned.splice(unassigned.indexOf(entry), 1);
          entry.slot = slotPos;
          this.#line(side, entry.player).slot = slotPos;
          remapped.push(entry);
        }
        outfield = outfield.filter((e) => !picked.includes(e));
      }
      side.onPitch = [...keeper, ...remapped];
      side.slotCounts = { GK: 1, DF: shape.DF, MF: shape.MF, FW: shape.FW };
      changes.unshift(formation);
    }

    if (changes.length > 0) {
      this.#log(Math.max(1, this.minute), 'tactics', sideKey, null,
        `${side.setup.shortName} switch to ${side.setup.formation} (${side.setup.mentality})`,
        { formation: side.setup.formation, mentality: side.setup.mentality });
    }
    return { ok: true, changed: changes.length > 0 };
  }

  // AI managers read the game: chase when behind late, protect a lead,
  // and dig in when down to ten men.
  #aiTacticsPolicy(sideKey, side) {
    if (!side.autoSubs || this.minute < 55) return;
    if (!this.rng.chance(0.06)) return;
    const diff = sideKey === 'home'
      ? this.score.home - this.score.away
      : this.score.away - this.score.home;
    const shortHanded = side.onPitch.length < 11;

    if (diff < 0 && side.setup.mentality !== 'attacking') {
      const formation = this.minute >= 75 && !shortHanded ? '4-3-3' : undefined;
      this.setTactics(sideKey, { mentality: 'attacking', formation });
    } else if (diff > 0 && this.minute >= 70 && side.setup.mentality !== 'defensive') {
      const formation = this.minute >= 82 ? '5-3-2' : undefined;
      this.setTactics(sideKey, { mentality: 'defensive', formation });
    } else if (diff === 0 && shortHanded && side.setup.mentality !== 'defensive') {
      this.setTactics(sideKey, { mentality: 'defensive' });
    }
  }

  // Public: make a substitution. Returns { ok } or { ok: false, error }.
  makeSub(sideKey, offId, onId) {
    const side = this.sides[sideKey];
    if (!side) return { ok: false, error: 'unknown side' };
    if (this.finished) return { ok: false, error: 'match is over' };
    if (side.subsUsed >= MAX_SUBS) return { ok: false, error: 'no substitutions left' };
    const offEntry = side.onPitch.find((e) => pid(e.player) === offId);
    if (!offEntry) return { ok: false, error: 'player is not on the pitch' };
    const onIdx = side.benchLeft.findIndex((p) => pid(p) === onId);
    if (onIdx === -1) return { ok: false, error: 'player is not on the bench' };

    const on = side.benchLeft.splice(onIdx, 1)[0];
    side.subsUsed++;
    const slot = offEntry.slot === 'GK' && on.pos !== 'GK' ? 'GK' : offEntry.slot;
    this.#removeFromPitch(side, offEntry.player);
    side.onPitch.push({ player: on, slot });
    const line = this.#line(side, on);
    line.slot = slot;
    this.#log(Math.max(1, this.minute), 'sub', sideKey, on,
      `${side.setup.shortName} substitution: ${on.name} replaces ${offEntry.player.name}`,
      { onId: pid(on), offId: pid(offEntry.player) });
    return { ok: true };
  }

  #bestBenchFor(side, slot) {
    const pool = side.benchLeft.filter((p) => p.pos !== 'GK' || unitOf(slot) === 'GK');
    if (pool.length === 0) return null;
    // Most familiar replacement first; ability breaks ties.
    return pool.reduce((best, p) => {
      const fp = familiarity(p, slot);
      const fb = familiarity(best, slot);
      return fp > fb || (fp === fb && p.atk + p.def > best.atk + best.def) ? p : best;
    });
  }

  #forcedSub(sideKey, side, offPlayer, slot) {
    if (side.subsUsed >= MAX_SUBS) return false;
    const replacement = this.#bestBenchFor(side, slot);
    if (!replacement) return false;
    return this.makeSub(sideKey, pid(offPlayer), pid(replacement)).ok;
  }

  // If the keeper is lost with no replacement, an outfielder goes in goal.
  #ensureKeeper(sideKey, side) {
    if (side.onPitch.some((e) => e.slot === 'GK')) return;
    const outfield = side.onPitch.filter((e) => e.slot !== 'GK');
    if (outfield.length === 0) return;
    const volunteer = outfield.reduce((best, e) =>
      (e.player.def > best.player.def ? e : best));
    volunteer.slot = 'GK';
    this.#line(side, volunteer.player).slot = 'GK';
    this.#log(Math.max(1, this.minute), 'sub', sideKey, volunteer.player,
      `${volunteer.player.name} pulls on the gloves — an emergency keeper!`,
      { onId: pid(volunteer.player), offId: null });
  }

  #autoSubPolicy(sideKey, side) {
    if (!side.autoSubs || side.subsUsed >= MAX_SUBS || side.benchLeft.length === 0) return;
    if (this.minute < 60 || this.minute > 85) return;
    if (!this.rng.chance(0.05)) return;
    const tired = side.onPitch
      .filter((e) => e.slot !== 'GK')
      .map((e) => ({ e, condition: this.#line(side, e.player).condition }))
      .filter((x) => x.condition < 80)
      .sort((a, b) => a.condition - b.condition)[0];
    if (!tired) return;
    this.#forcedSub(sideKey, side, tired.e.player, tired.e.slot);
  }

  // The minute loop is an ordered pipeline of named phases. The order fixes
  // the RNG draw sequence — AI policies (home, away) → possession →
  // build-up → discipline (home, away) → injuries (home, away) → chance
  // creation/resolution — and is load-bearing: reordering phases, or moving
  // an RNG draw between them, changes every match played from a given seed.
  // The golden-master suite exists to catch exactly that.
  static MINUTE_PHASES = [
    'halfTimeWhistle',
    'aiPolicies',
    'possession',
    'buildUp',
    'discipline',
    'injuries',
    'chanceCreation',
    'fatigue',
    'snapshot',
    'clock',
  ];

  #phases = {
    halfTimeWhistle: (ctx) => this.#phaseHalfTimeWhistle(ctx),
    aiPolicies: (ctx) => this.#phaseAiPolicies(ctx),
    possession: (ctx) => this.#phasePossession(ctx),
    buildUp: (ctx) => this.#phaseBuildUp(ctx),
    discipline: (ctx) => this.#phaseDiscipline(ctx),
    injuries: (ctx) => this.#phaseInjuries(ctx),
    chanceCreation: (ctx) => this.#phaseChanceCreation(ctx),
    fatigue: (ctx) => this.#phaseFatigue(ctx),
    snapshot: (ctx) => this.#phaseSnapshot(ctx),
    clock: (ctx) => this.#phaseClock(ctx),
  };

  playMinute() {
    if (this.finished) return [];
    this.turnEvents = [];
    this.minute++;
    // Shared per-minute context: phases communicate only through it (the
    // possession phase writes attackerKey/att/def; build-up and chance
    // creation read them). Later milestones add state here, not new
    // signatures.
    const ctx = { minute: this.minute, rng: this.rng };
    for (const name of this.constructor.MINUTE_PHASES) {
      this.#phases[name](ctx);
      this.phaseHook?.(name, ctx);
    }
    return this.turnEvents;
  }

  #phaseHalfTimeWhistle(ctx) {
    if (ctx.minute !== 46) return;
    this.#log(45, 'half-time', null, null,
      `Half time: ${this.sides.home.setup.name} ${this.score.home} - ${this.score.away} ${this.sides.away.setup.name}`,
      { score: { home: this.score.home, away: this.score.away } });
  }

  #phaseAiPolicies() {
    for (const [key, side] of Object.entries(this.sides)) {
      this.#aiTacticsPolicy(key, side);
      this.#autoSubPolicy(key, side);
    }
  }

  // Who has the ball this minute: midfield battle plus home advantage.
  #phasePossession(ctx) {
    const homeMid = this.#strength(this.sides.home, 'midfield');
    const awayMid = this.#strength(this.sides.away, 'midfield');
    ctx.attackerKey = ctx.rng.chance(homeMid / (homeMid + awayMid)) ? 'home' : 'away';
    ctx.defenderKey = ctx.attackerKey === 'home' ? 'away' : 'home';
    ctx.att = this.sides[ctx.attackerKey];
    ctx.def = this.sides[ctx.defenderKey];
    ctx.att.possessionMinutes++;
  }

  // Quiet build-up play drives passes, tackles and the live ratings.
  #phaseBuildUp(ctx) {
    const { rng, att, def } = ctx;
    const passAttempts = rng.int(3, 8);
    for (let i = 0; i < passAttempts; i++) {
      const passer = this.#pick(att, PASS_WEIGHT, POSITIONS);
      if (!passer) break;
      const skill = attrOf(passer.player, 'passing');
      if (rng.chance(0.6 + (skill / 99) * 0.32)) {
        this.#line(att, passer.player).passes++;
        this.#rate(att, passer.player, RATING.pass);
      }
    }
    if (rng.chance(0.35)) {
      const tackler = this.#pick(def, TACKLE_WEIGHT, ['DF', 'MF', 'FW']);
      if (tackler && rng.chance(0.45 + (attrOf(tackler.player, 'tackling') / 99) * 0.4)) {
        this.#line(def, tackler.player).tackles++;
        this.#rate(def, tackler.player, RATING.tackle);
      }
    }
  }

  // Fouls and cards.
  #phaseDiscipline(ctx) {
    const { minute, rng } = ctx;
    for (const [key, side] of Object.entries(this.sides)) {
      if (!rng.chance(0.11)) continue;
      side.stats.fouls++;
      const offEntry = this.#pick(side, { DF: 1, MF: 1, FW: 1 }, ['DF', 'MF', 'FW']);
      if (!offEntry) continue;
      const offender = offEntry.player;
      this.#line(side, offender).fouls++;
      this.#rate(side, offender, RATING.foul);
      this.#log(minute, 'foul', key, offender,
        fill(rng.pick(COMMENTARY.foul), { player: offender.name }),
        { playerId: pid(offender) });

      const straightRed = rng.chance(0.006);
      const booked = !straightRed && rng.chance(0.11);
      if (booked) {
        if (side.yellowCarded.has(offender.name)) {
          side.stats.redCards++;
          side.sentOff.add(offender.name);
          this.#line(side, offender).red++;
          this.#rate(side, offender, RATING.red);
          this.#removeFromPitch(side, offender);
          this.#ensureKeeper(key, side);
          this.#log(minute, 'red', key, offender,
            `Second yellow! ${offender.name} is off — ${side.setup.name} are down to ${side.onPitch.length} men!`,
            { playerId: pid(offender) });
        } else {
          side.yellowCarded.add(offender.name);
          side.stats.yellowCards++;
          this.#line(side, offender).yellow++;
          this.#rate(side, offender, RATING.yellow);
          this.#log(minute, 'yellow', key, offender,
            fill(rng.pick(COMMENTARY.yellow), { player: offender.name }),
            { playerId: pid(offender) });
        }
      } else if (straightRed) {
        side.stats.redCards++;
        side.sentOff.add(offender.name);
        this.#line(side, offender).red++;
        this.#rate(side, offender, RATING.red);
        this.#removeFromPitch(side, offender);
        this.#ensureKeeper(key, side);
        this.#log(minute, 'red', key, offender,
          fill(rng.pick(COMMENTARY.red), {
            player: offender.name,
            team: side.setup.name,
            count: side.onPitch.length,
          }),
          { playerId: pid(offender) });
      }
    }

  }

  // Injuries: a knock serious enough to end the player's involvement.
  #phaseInjuries(ctx) {
    const { minute, rng } = ctx;
    for (const [key, side] of Object.entries(this.sides)) {
      if (!rng.chance(0.0018)) continue;
      const victims = side.onPitch.map((e) => ({
        item: e,
        weight: (e.player.injuryProne ?? 50) *
          (this.#line(side, e.player).condition < 65 ? 2 : 1),
      }));
      if (victims.length === 0) continue;
      const entry = rng.weightedPick(victims);
      const weeks = rng.weightedPick([
        { item: rng.int(1, 2), weight: 60 },
        { item: rng.int(3, 4), weight: 25 },
        { item: rng.int(5, 8), weight: 12 },
        { item: rng.int(9, 16), weight: 3 },
      ]);
      this.injuries.push({
        side: key, id: pid(entry.player), player: entry.player.name, minute, weeks,
      });
      this.#log(minute, 'injury', key, entry.player,
        fill(rng.pick(COMMENTARY.injury), { player: entry.player.name }),
        { playerId: pid(entry.player), weeks });
      // AI-managed sides substitute immediately (makeSub removes the
      // injured player). A user-managed side (autoSubs false) is left a
      // man short until the manager reacts — the UI pauses for it.
      if (!side.autoSubs || !this.#forcedSub(key, side, entry.player, entry.slot)) {
        this.#removeFromPitch(side, entry.player);
      }
      this.#ensureKeeper(key, side);
    }

  }

  // Does the attacking team fashion a chance?
  #phaseChanceCreation(ctx) {
    const { rng, att, def } = ctx;
    const atkStrength = this.#strength(att, 'attack');
    const defStrength = this.#strength(def, 'defense');
    const mods = MENTALITY_MODS[att.setup.mentality].create *
      MENTALITY_MODS[def.setup.mentality].concede;
    const chanceProb = clamp(
      BASE_CHANCE_PROB * mods * (2 * atkStrength) / (atkStrength + defStrength),
      0.06, 0.5
    );
    if (rng.chance(chanceProb)) this.#resolveChance(ctx.attackerKey, att, ctx.defenderKey, def);
  }

  // Legs get heavier as the match wears on; high stamina fades slower
  // (ATTR-06). The slope is steeper than the spec's illustrative 1/198 —
  // that constant caps the 90-vs-40 stamina gap at 6.8 points over 90
  // minutes, short of the >8 its own test plan demands. 1/165 delivers
  // it, and the legacy fallback (49.5) still lands on a factor of 1.0.
  #phaseFatigue() {
    for (const side of Object.values(this.sides)) {
      for (const e of side.onPitch) {
        const line = this.#line(side, e.player);
        line.minutes++;
        const decay = (e.slot === 'GK' ? 0.08 : 0.3) *
          (1.30 - attrOf(e.player, 'stamina') / 165);
        line.condition = Math.max(20, line.condition - decay);
      }
    }
  }

  #phaseSnapshot(ctx) {
    if (!this.trackTimeline) return;
    this.timeline.push({
      minute: ctx.minute,
      home: [...this.sides.home.lines.values()].map((l) => ({ ...l })),
      away: [...this.sides.away.lines.values()].map((l) => ({ ...l })),
    });
  }

  #phaseClock(ctx) {
    if (ctx.minute >= this.finalMinute) this.#endStage();
  }

  #resolveChance(attackerKey, att, defenderKey, def) {
    const rng = this.rng;
    const minute = this.minute;
    const shooterEntry = this.#pick(att, SHOOT_WEIGHT, ['DF', 'MF', 'FW']);
    if (!shooterEntry) return;
    const shooter = shooterEntry.player;

    att.stats.shots++;
    this.#line(att, shooter).shots++;
    this.#log(minute, 'chance', attackerKey, shooter,
      fill(rng.pick(COMMENTARY.chanceBuild), {
        player: shooter.name,
        team: att.setup.name,
        opponent: def.setup.name,
      }),
      { playerId: pid(shooter) });

    const missProb = clamp(0.42 - attrOf(shooter, 'finishing') * 0.0015, 0.2, 0.4);
    if (rng.chance(missProb)) {
      this.#rate(att, shooter, RATING.shotOff);
      this.#log(minute, 'miss', attackerKey, shooter,
        fill(rng.pick(COMMENTARY.miss), { player: shooter.name }),
        { playerId: pid(shooter) });
      return;
    }
    if (rng.chance(0.22)) {
      this.#rate(att, shooter, RATING.shotOff);
      const blocker = this.#pick(def, { DF: 1 }, ['DF']);
      if (blocker) {
        this.#line(def, blocker.player).tackles++;
        this.#rate(def, blocker.player, RATING.tackle);
      }
      this.#log(minute, 'block', attackerKey, shooter,
        fill(rng.pick(COMMENTARY.block), { player: shooter.name }),
        { playerId: pid(shooter) });
      if (rng.chance(0.55)) {
        att.stats.corners++;
        this.#log(minute, 'corner', attackerKey, null,
          fill(rng.pick(COMMENTARY.corner), { team: att.setup.name }));
      }
      return;
    }

    att.stats.onTarget++;
    this.#line(att, shooter).onTarget++;
    this.#rate(att, shooter, RATING.shotOnTarget);
    const gkStrength = this.#strength(def, 'goalkeeping');
    const keeperEntry = def.onPitch.find((e) => e.slot === 'GK') ?? null;
    const finishing = attrOf(shooter, 'finishing');
    const goalProb = finishing / (finishing + gkStrength * 4);
    if (rng.chance(goalProb)) {
      this.score[attackerKey]++;
      att.scorers.push({ player: shooter.name, minute });
      this.#line(att, shooter).goals++;
      this.#rate(att, shooter, RATING.goal);

      const providers = att.onPitch.filter(
        (e) => e.slot !== 'GK' && pid(e.player) !== pid(shooter)
      );
      let assistId = null;
      if (providers.length > 0 && rng.chance(0.6)) {
        const provider = rng.weightedPick(
          providers.map((e) => ({ item: e, weight: ASSIST_WEIGHT[unitOf(e.slot)] ?? 1 }))
        );
        assistId = pid(provider.player);
        this.#line(att, provider.player).assists++;
        this.#rate(att, provider.player, RATING.assist);
      }

      if (keeperEntry) this.#rate(def, keeperEntry.player, RATING.concedeGk);
      for (const d of def.onPitch.filter((e) => unitOf(e.slot) === 'DF')) {
        this.#rate(def, d.player, RATING.concedeDf);
      }

      this.#log(minute, 'goal', attackerKey, shooter,
        fill(rng.pick(COMMENTARY.goal), { player: shooter.name, team: att.setup.name }),
        {
          playerId: pid(shooter),
          assistId,
          score: { home: this.score.home, away: this.score.away },
        });
    } else {
      if (keeperEntry) {
        this.#line(def, keeperEntry.player).saves++;
        this.#rate(def, keeperEntry.player, RATING.save);
      }
      this.#log(minute, 'save', attackerKey, shooter,
        fill(rng.pick(COMMENTARY.save), { player: shooter.name }),
        { shooterId: pid(shooter), keeperId: keeperEntry ? pid(keeperEntry.player) : null });
      if (rng.chance(0.35)) {
        att.stats.corners++;
        this.#log(minute, 'corner', attackerKey, null,
          fill(rng.pick(COMMENTARY.corner), { team: att.setup.name }));
      }
    }
  }

  #endStage() {
    const level = this.score.home === this.score.away;
    if (this.knockout && level && !this.inExtraTime) {
      this.inExtraTime = true;
      this.finalMinute = this.minute + 30 + this.rng.int(1, 2);
      this.#log(this.minute, 'extra-time', null, null,
        `Level after 90 — we're going to extra time!`);
      return;
    }
    if (this.knockout && level && this.inExtraTime) {
      this.#shootout();
    }
    this.#complete();
  }

  #shootout() {
    const rng = this.rng;
    this.#log(this.minute, 'penalties', null, null,
      'Still level — it goes to a penalty shootout!');
    const takers = {};
    const keepers = {};
    for (const key of ['home', 'away']) {
      const side = this.sides[key];
      takers[key] = [...side.onPitch]
        .filter((e) => e.slot !== 'GK')
        .sort((a, b) => attrOf(b.player, 'finishing') - attrOf(a.player, 'finishing'))
        .map((e) => e.player);
      if (takers[key].length === 0) {
        takers[key] = side.onPitch.map((e) => e.player);
      }
      const gk = side.onPitch.find((e) => e.slot === 'GK');
      keepers[key] = gk ? gk.player : { def: 20, name: 'nobody' };
    }
    const tally = { home: 0, away: 0 };
    const taken = { home: 0, away: 0 };

    const kick = (key) => {
      const oppKeeper = keepers[key === 'home' ? 'away' : 'home'];
      const taker = takers[key][taken[key] % takers[key].length];
      taken[key]++;
      const p = clamp(
        0.76 + (attrOf(taker, 'finishing') - attrOf(oppKeeper, 'reflexes')) * 0.0015,
        0.55, 0.92);
      const scored = rng.chance(p);
      if (scored) {
        tally[key]++;
        this.#rate(this.sides[key], taker, RATING.penScored);
      } else {
        this.#rate(this.sides[key], taker, RATING.penMissed);
      }
      this.#log(this.minute, scored ? 'penalty-scored' : 'penalty-missed', key, taker,
        scored
          ? `${taker.name} scores! ${tally.home}-${tally.away}`
          : `${taker.name} misses! Still ${tally.home}-${tally.away}`,
        { playerId: pid(taker), tally: { home: tally.home, away: tally.away } });
      return scored;
    };

    // Five rounds each, finishing early once the tie is decided.
    for (let round = 0; round < 5; round++) {
      for (const key of ['home', 'away']) {
        const other = key === 'home' ? 'away' : 'home';
        kick(key);
        const decided =
          tally[key] > tally[other] + Math.max(0, 5 - taken[other]) ||
          tally[other] > tally[key] + Math.max(0, 5 - taken[key]);
        if (decided) {
          this.shootout = tally;
          return this.#finishShootout();
        }
      }
    }
    // Sudden death.
    for (let round = 0; round < 20 && tally.home === tally.away; round++) {
      kick('home');
      kick('away');
    }
    if (tally.home === tally.away) tally[this.rng.chance(0.5) ? 'home' : 'away']++;
    this.shootout = tally;
    this.#finishShootout();
  }

  #finishShootout() {
    const winner = this.shootout.home > this.shootout.away ? 'home' : 'away';
    this.#log(this.minute, 'shootout-end', winner, null,
      `${this.sides[winner].setup.name} win the shootout ${this.shootout.home}-${this.shootout.away}!`,
      { tally: { home: this.shootout.home, away: this.shootout.away } });
  }

  #complete() {
    this.finished = true;

    for (const [key, side] of Object.entries(this.sides)) {
      const conceded = key === 'home' ? this.score.away : this.score.home;
      if (conceded === 0) {
        for (const e of side.onPitch.filter((x) => ['GK', 'DF'].includes(unitOf(x.slot)))) {
          this.#rate(side, e.player, RATING.cleanSheet);
        }
      }
    }
    if (this.trackTimeline && this.timeline.length > 0) {
      const last = this.timeline[this.timeline.length - 1];
      last.home = [...this.sides.home.lines.values()].map((l) => ({ ...l }));
      last.away = [...this.sides.away.lines.values()].map((l) => ({ ...l }));
    }

    this.#log(this.minute, 'full-time', null, null,
      `Full time: ${this.sides.home.setup.name} ${this.score.home} - ${this.score.away} ${this.sides.away.setup.name}` +
      (this.shootout ? ` (${this.shootout.home}-${this.shootout.away} on penalties)` : ''),
      {
        score: { home: this.score.home, away: this.score.away },
        shootout: this.shootout
          ? { home: this.shootout.home, away: this.shootout.away } : null,
      });

    const total = this.sides.home.possessionMinutes + this.sides.away.possessionMinutes;
    this.sides.home.stats.possession = Math.round(
      (this.sides.home.possessionMinutes / Math.max(1, total)) * 100);
    this.sides.away.stats.possession = 100 - this.sides.home.stats.possession;
  }

  simulateToEnd() {
    while (!this.finished) this.playMinute();
    return this;
  }

  finish() {
    if (!this.finished) this.simulateToEnd();
    let winner = 'draw';
    if (this.score.home !== this.score.away) {
      winner = this.score.home > this.score.away ? 'home' : 'away';
    } else if (this.shootout) {
      winner = this.shootout.home > this.shootout.away ? 'home' : 'away';
    }
    return {
      seed: this.seed,
      homeTeam: this.sides.home.setup.name,
      awayTeam: this.sides.away.setup.name,
      score: this.score,
      winner,
      shootout: this.shootout,
      playedMinutes: this.minute,
      events: this.events,
      stats: { home: this.sides.home.stats, away: this.sides.away.stats },
      scorers: { home: this.sides.home.scorers, away: this.sides.away.scorers },
      playerStats: {
        home: [...this.sides.home.lines.values()],
        away: [...this.sides.away.lines.values()],
      },
      injuries: this.injuries,
      subsUsed: { home: this.sides.home.subsUsed, away: this.sides.away.subsUsed },
      timeline: this.trackTimeline ? this.timeline : null,
    };
  }
}

export function simulateMatch(home, away, options = {}) {
  return new MatchSim(home, away, options).finish();
}
