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
  INSTRUCTION_AXES, DEFAULT_INSTRUCTION, instructionMods, sanitizeInstruction,
  instructionPreset,
} from './team.js';
import { attrOf, unitContribution } from './players.js';

const HOME_ADVANTAGE = 1.12; // multiplier on home midfield/attack effectiveness
const MAX_SUBS = 3;

// --- Ball model (EE-5) -------------------------------------------------------
// The ball is in one of three zones (home's D / M / home's A) and belongs
// to one side. Each minute runs TICKS_PER_MINUTE transition rolls; chances
// can only arise with the ball in the owner's attacking third. The BASE_*
// weights are the calibration surface: they reproduce the pre-EE-5
// scoreline profile (goals/match, home advantage, shots/side) while
// letting shots cluster into spells of pressure.
const TICKS_PER_MINUTE = 3;
const BASE_ADVANCE = 0.34;
const BASE_HOLD = 0.38;
const FINAL_THIRD_STICKINESS = 1.35; // attackers recycle the ball in the box
const BASE_TURNOVER = 0.28;
const TICK_CHANCE = 0.17; // per final-third tick, before quality mods
// Momentum (EE-5): the last ten minutes of territory feed the advance
// roll, so spells of pressure persist at the scale a watching manager
// sees. Strictly bounded, and it never touches chance conversion — shots
// cluster, goals stay near-Poisson.
const MOMENTUM_WINDOW = 10; // minutes
const MOMENTUM_PUSH = 0.12; // max ± effect on advance weight
const ZONES = ['D', 'M', 'A']; // always from HOME's perspective

// Mentality acts on ball flow (EE-5): attackers push forward and hold
// less; defensive sides advance less but are harder to dislodge in their
// own third. The old chance-side concede modifier survives on the
// final-third chance roll (attacking sides leave space behind).
const MENTALITY_FLOW = {
  attacking: { adv: 1.12, hold: 0.95, ownThirdTurn: 1 },
  normal: { adv: 1, hold: 1, ownThirdTurn: 1 },
  defensive: { adv: 0.88, hold: 1, ownThirdTurn: 0.92 },
};

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

// Since EE-5 the create side of mentality lives in MENTALITY_FLOW (it
// shapes how often a side reaches the final third); concede still scales
// the quality of chances given up once the opponent is there.
const MENTALITY_MODS = {
  defensive: { concede: 0.9 },
  normal: { concede: 1 },
  attacking: { concede: 1.08 },
};

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

const COMMENTARY = {
  chanceBuild: [
    '{player} finds space on the edge of the box',
    '{team} work it wide and whip in a cross',
    'A slick one-two opens up the {opponent} defence',
    '{player} drives at the back line',
  ],
  // Zone-flavoured build-up (EE-5): pool chosen from the flow state, so
  // the pick itself stays a single draw either way.
  chanceCamped: [
    '{team} are camped in the final third — {player} lines one up',
    'Wave after wave from {team}; {player} takes aim',
    'The {opponent} defence cannot clear — {player} pounces',
  ],
  chanceBreak: [
    '{team} break from deep at pace — {player} leads the charge',
    'A lightning counter from {team}! {player} bears down on goal',
    '{player} carries it the length of the half on the break',
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

// Attach a per-slot instruction to each starter: raw.instructions[i]
// aligns to starters[i] (both follow the formation's slot order), with a
// per-starter instr as the fallback shape.
function withInstructions(starters, instructions) {
  return starters.map((s, i) => ({
    player: s.player,
    slot: s.slot,
    instr: sanitizeInstruction(instructions?.[i] ?? s.instr, s.slot),
  }));
}

function normalizeSetup(raw) {
  if (!raw || typeof raw !== 'object') return { error: 'setup is not an object' };
  if (raw.starters) {
    return {
      name: raw.name,
      shortName: raw.shortName ?? raw.name,
      starters: withInstructions(raw.starters, raw.instructions),
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
      starters: withInstructions(picked.starters, raw.instructions),
      bench: picked.bench,
      formation: picked.formation,
      mentality: raw.mentality ?? 'normal',
    };
  }
  return {
    name: raw.name,
    shortName: raw.shortName ?? raw.name,
    starters: withInstructions(
      (raw.players ?? []).map((p) => ({ player: p, slot: p?.position ?? p?.pos })),
      raw.instructions
    ),
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
    // EE-5: the ball is somewhere. Zone is always from HOME's perspective
    // ('A' = home's attacking third); kick-off gives home the ball at M.
    this.ball = { zone: 'M', owner: 'home' };
    this.flow = []; // per-tick {minute, tick, zone, owner} — EE-7's camera feed
    this.zoneTicks = { A: 0, D: 0 }; // territory tally, home perspective
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
      onPitch: setup.starters.map((s) => ({
        player: s.player, slot: s.slot, instr: s.instr, mods: instructionMods(s.instr),
      })),
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
        territoryPct: 0, finalThirdEntries: 0,
      },
      ownedTicks: 0,
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
  // the attributes that should drive it (EE-3, unitContribution). When a
  // unit feeds an attacking or defensive strength, each entry's runs
  // instruction scales its contribution (EE-4, modKey atkC/defC).
  #unit(side, unit, modKey = null) {
    const entries = side.onPitch.filter((e) => unitOf(e.slot) === unit);
    if (unit === 'GK') {
      if (entries.length === 0) return 5;
      return this.#eff(side, entries[0], unitContribution(entries[0].player, 'GK'));
    }
    const total = entries.reduce(
      (sum, e) => sum + this.#eff(side, e, unitContribution(e.player, unit)) *
        (modKey ? e.mods[modKey] : 1), 0);
    return Math.max(5, total / Math.max(1, side.slotCounts[unit]));
  }

  // Mean instruction modifier over the on-pitch outfield — the team-level
  // reading of a per-player axis (press effects scale with how many
  // players actually press). Defaults are exact identities.
  #meanMod(side, key) {
    const entries = side.onPitch.filter((e) => unitOf(e.slot) !== 'GK');
    if (entries.length === 0) return key === 'oppPass' ? 0 : 1;
    return entries.reduce((sum, e) => sum + e.mods[key], 0) / entries.length;
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
        0.8 * this.#unit(side, 'FW', 'atkC') * this.#headcount(side, 'FW', 2, 0.5) +
        0.2 * this.#unit(side, 'MF', 'atkC')
      ) * side.boost;
    }
    if (kind === 'defense') {
      return 0.8 * this.#unit(side, 'DF', 'defC') * this.#headcount(side, 'DF', 4, 0.5) +
        0.2 * this.#unit(side, 'MF', 'defC');
    }
    return this.#unit(side, 'GK');
  }

  // weights and slots are unit-level; on-pitch slots may be detailed.
  // modKey scales each entry's weight by its instruction modifier (EE-4).
  #pick(side, weights, slots, modKey = null) {
    const pool = side.onPitch.filter((e) => slots.includes(unitOf(e.slot)));
    if (pool.length === 0) return null;
    return this.rng.weightedPick(pool.map((e) => ({
      item: e,
      weight: (weights[unitOf(e.slot)] ?? 1) * (modKey ? e.mods[modKey] : 1),
    })));
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
    let instructionResets = 0;
    if (formation && formation !== side.setup.formation) {
      side.setup.formation = formation;
      const shape = FORMATIONS[formation];
      const keeper = side.onPitch.filter((e) => unitOf(e.slot) === 'GK');
      let outfield = side.onPitch.filter((e) => unitOf(e.slot) !== 'GK');
      // Instructions belong to the slot: a player keeping his slot name
      // keeps its instructions; one remapped to a different slot starts
      // from defaults (the orphan-reset rule).
      const prevSlots = new Map(side.onPitch.map((e) => [pid(e.player), e.slot]));

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
      for (const e of remapped) {
        if (e.slot !== prevSlots.get(pid(e.player))) {
          if (e.instr.runs !== DEFAULT_INSTRUCTION.runs ||
              e.instr.press !== DEFAULT_INSTRUCTION.press) instructionResets++;
          e.instr = { ...DEFAULT_INSTRUCTION };
          e.mods = instructionMods(e.instr);
        }
      }
      changes.unshift(formation);
    }

    if (changes.length > 0) {
      const resetNote = instructionResets > 0
        ? ` — ${instructionResets} player instruction${instructionResets === 1 ? '' : 's'} reset` : '';
      this.#log(Math.max(1, this.minute), 'tactics', sideKey, null,
        `${side.setup.shortName} switch to ${side.setup.formation} (${side.setup.mentality})${resetNote}`,
        {
          formation: side.setup.formation,
          mentality: side.setup.mentality,
          // Only present when instructions were actually reset, so
          // default-instruction matches stay byte-identical (PTI-08).
          ...(instructionResets > 0 ? { instructionResets } : {}),
        });
    }
    return { ok: true, changed: changes.length > 0 };
  }

  // Public: set one instruction axis for the player currently occupying a
  // slot (EE-4). Draws no RNG; effects flow through existing draws.
  setInstruction(sideKey, playerId, axis, value) {
    const side = this.sides[sideKey];
    if (!side) return { ok: false, error: 'unknown side' };
    if (this.finished) return { ok: false, error: 'match is over' };
    if (!INSTRUCTION_AXES[axis]) return { ok: false, error: `unknown axis: ${axis}` };
    if (!INSTRUCTION_AXES[axis].includes(value)) {
      return { ok: false, error: `unknown ${axis} value: ${value}` };
    }
    const entry = side.onPitch.find((e) => pid(e.player) === playerId);
    if (!entry) return { ok: false, error: 'player is not on the pitch' };
    if (unitOf(entry.slot) === 'GK') {
      return { ok: false, error: 'keeper instructions are fixed' };
    }
    if (entry.instr[axis] === value) return { ok: true, changed: false };
    entry.instr = { ...entry.instr, [axis]: value };
    entry.mods = instructionMods(entry.instr);
    const phrase = {
      runs: { forward: 'get forward', balanced: 'play his natural game', hold: 'hold his position' },
      press: { high: 'press high', normal: 'press normally', deep: 'sit deep' },
    }[axis][value];
    this.#log(Math.max(1, this.minute), 'instruction', sideKey, entry.player,
      `${entry.player.name} told to ${phrase}`,
      { playerId, axis, value });
    return { ok: true, changed: true };
  }

  // Public: swap two on-pitch players between their slots (12 · DRG-05).
  // Instructions belong to the slot, so each player takes over the slot's
  // existing instructions. The keeper's slot is off-limits — goalkeeping
  // changes go through substitutions or the emergency-keeper rule.
  // Draws no RNG; a scripted swap replays byte-identically.
  swapPositions(sideKey, idA, idB) {
    const side = this.sides[sideKey];
    if (!side) return { ok: false, error: 'unknown side' };
    if (this.finished) return { ok: false, error: 'match is over' };
    if (idA === idB) return { ok: false, error: 'pick two different players' };
    const a = side.onPitch.find((e) => pid(e.player) === idA);
    const b = side.onPitch.find((e) => pid(e.player) === idB);
    if (!a || !b) return { ok: false, error: 'player is not on the pitch' };
    if (unitOf(a.slot) === 'GK' || unitOf(b.slot) === 'GK') {
      return { ok: false, error: 'the keeper stays in goal — substitute him instead' };
    }
    [a.slot, b.slot] = [b.slot, a.slot];
    [a.instr, b.instr] = [b.instr, a.instr];
    [a.mods, b.mods] = [b.mods, a.mods];
    this.#line(side, a.player).slot = a.slot;
    this.#line(side, b.player).slot = b.slot;
    this.#log(Math.max(1, this.minute), 'position', sideKey, a.player,
      `${a.player.name} and ${b.player.name} swap positions (${a.slot} ↔ ${b.slot})`,
      { aId: idA, bId: idB, aSlot: a.slot, bSlot: b.slot });
    return { ok: true };
  }

  // Re-derive an AI side's instructions from its (new) mentality (PTI-06).
  #applyInstructionPreset(side) {
    for (const e of side.onPitch) {
      e.instr = instructionPreset(side.setup.mentality, e.slot);
      e.mods = instructionMods(e.instr);
    }
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
      this.#applyInstructionPreset(side);
    } else if (diff > 0 && this.minute >= 70 && side.setup.mentality !== 'defensive') {
      const formation = this.minute >= 82 ? '5-3-2' : undefined;
      this.setTactics(sideKey, { mentality: 'defensive', formation });
      this.#applyInstructionPreset(side);
    } else if (diff === 0 && shortHanded && side.setup.mentality !== 'defensive') {
      this.setTactics(sideKey, { mentality: 'defensive' });
      this.#applyInstructionPreset(side);
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
    // Instructions travel with the shirt: the replacement inherits the
    // outgoing slot's instructions (keeper slots stay fixed).
    const instr = unitOf(slot) === 'GK' ? { ...DEFAULT_INSTRUCTION } : offEntry.instr;
    this.#removeFromPitch(side, offEntry.player);
    side.onPitch.push({ player: on, slot, instr, mods: instructionMods(instr) });
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
    volunteer.instr = { ...DEFAULT_INSTRUCTION };
    volunteer.mods = instructionMods(volunteer.instr);
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
  // the RNG draw sequence — AI policies (home, away) → ball flow (EE-5:
  // zone transitions, build-up, chance creation) → discipline (home, away)
  // → injuries (home, away) — and is load-bearing: reordering phases, or
  // moving an RNG draw between them, changes every match played from a
  // given seed. The golden-master suite exists to catch exactly that.
  static MINUTE_PHASES = [
    'halfTimeWhistle',
    'aiPolicies',
    'ballFlow',
    'discipline',
    'injuries',
    'fatigue',
    'snapshot',
    'clock',
  ];

  // Rolling per-minute territory tallies ({A, D} ticks) for momentum and
  // the live territory bar; capped at MOMENTUM_WINDOW entries.
  #terrWindow = [];

  #momentum() {
    let a = 0;
    let d = 0;
    for (const m of this.#terrWindow) {
      a += m.A;
      d += m.D;
    }
    return (a + d) === 0 ? 0 : (a - d) / (a + d);
  }

  // Public read for the UI: recent territory as a home-share percentage.
  recentTerritory() {
    const m = this.#momentum();
    return Math.round(50 + m * 50);
  }

  #phases = {
    halfTimeWhistle: (ctx) => this.#phaseHalfTimeWhistle(ctx),
    aiPolicies: (ctx) => this.#phaseAiPolicies(ctx),
    ballFlow: (ctx) => this.#phaseBallFlow(ctx),
    discipline: (ctx) => this.#phaseDiscipline(ctx),
    injuries: (ctx) => this.#phaseInjuries(ctx),
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

  // The owner's view of the ball zone: home reads it directly; away reads
  // the mirror (home's D is away's attacking third).
  #ownerZone(owner = this.ball.owner) {
    if (owner === 'home') return this.ball.zone;
    return this.ball.zone === 'A' ? 'D' : this.ball.zone === 'D' ? 'A' : 'M';
  }

  #inFinalThird(owner = this.ball.owner) {
    return this.#ownerZone(owner) === 'A';
  }

  // Transition weights for one tick (EE-5 §4.1). Advancing out of your own
  // third is a midfield contest; breaking into the final third is attack
  // vs defence. Pressing (EE-4) forces turnovers in the owner's D/M and
  // eases the path into the final third when sitting deep.
  #tickWeights(str) {
    const ownerKey = this.ball.owner;
    const defKey = ownerKey === 'home' ? 'away' : 'home';
    const owner = this.sides[ownerKey];
    const def = this.sides[defKey];
    const oz = this.#ownerZone();
    const flow = MENTALITY_FLOW[owner.setup.mentality];

    // Quality ratios are tempered (^0.75): the zone model multiplies more
    // quality channels than the old single possession coin-flip did, so
    // each channel must bite less for the same overall strength gradient.
    const ratio = (a, b) => clamp((2 * a) / (a + b), 0.6, 1.6) ** 0.75;
    let zoneStep = 1;
    if (oz === 'D') zoneStep = ratio(str[ownerKey].midfield, str[defKey].midfield);
    if (oz === 'M') {
      zoneStep = ratio(str[ownerKey].attack, str[defKey].defense) *
        // Sitting deep concedes ground into the final third (EE-4 concedeQ
        // re-expressed spatially; the quality cost lands on the chance roll)
        // and an attacking opponent leaves space behind to advance into.
        (1 + (1 - this.#meanMod(def, 'concedeQ')) * 2) *
        (def.setup.mentality === 'attacking' ? 1.06 : 1);
    }

    // Keeping the ball is a quality contest: a stronger side in midfield
    // is dislodged less (this is what makes possession follow strength).
    const zonePressure = ratio(str[defKey].midfield, str[ownerKey].midfield);
    // Momentum: a side camped in the opponent's half keeps coming.
    const m = this.#momentum();
    const push = 1 + MOMENTUM_PUSH * (ownerKey === 'home' ? m : -m);
    // Pressers dislodge the ball high up: scale opponent turnovers in
    // their D/M from the pressing side's tackleW (1.4 all-high → ×1.25).
    const press = oz === 'A' ? 1 : 1 + (this.#meanMod(def, 'tackleW') - 1) * 0.625;
    const ownThird = oz === 'D' ? flow.ownThirdTurn : 1;

    // Spells of pressure: once settled in the final third, the attacking
    // side recycles the ball — this is where shot clustering comes from.
    const sticky = oz === 'A' ? FINAL_THIRD_STICKINESS : 1;
    return [
      { item: 'advance', weight: BASE_ADVANCE * zoneStep * flow.adv * push },
      { item: 'hold', weight: BASE_HOLD * flow.hold * sticky },
      { item: 'turnover', weight: BASE_TURNOVER * zonePressure * press * ownThird },
    ];
  }

  // Chance quality once the ball is in the owner's final third: shot
  // frequency scales with attack-vs-defence quality, the defender's
  // mentality (attackers leave space behind), and sit-deep chance
  // softening (EE-4 concedeQ).
  #tickChanceProb(str) {
    const ownerKey = this.ball.owner;
    const defKey = ownerKey === 'home' ? 'away' : 'home';
    const def = this.sides[defKey];
    const quality = (2 * str[ownerKey].attack) /
      (str[ownerKey].attack + str[defKey].defense);
    return clamp(
      TICK_CHANCE * quality * MENTALITY_MODS[def.setup.mentality].concede *
        this.#meanMod(def, 'concedeQ'),
      0.02, 0.35
    );
  }

  // One EE-5 tick of quiet play: the owner strings passes, the defender
  // hunts the ball — the same bookkeeping volumes as the old per-minute
  // loop, now proportional to held ticks (EE-4 press modifiers intact).
  #tickBuildUp(rng) {
    const att = this.sides[this.ball.owner];
    const def = this.sides[this.ball.owner === 'home' ? 'away' : 'home'];
    const passAttempts = rng.int(1, 3);
    const pressShift = this.#meanMod(def, 'oppPass') / 100;
    for (let i = 0; i < passAttempts; i++) {
      const passer = this.#pick(att, PASS_WEIGHT, POSITIONS);
      if (!passer) break;
      const skill = attrOf(passer.player, 'passing');
      if (rng.chance(0.6 + (skill / 99) * 0.32 + pressShift)) {
        this.#line(att, passer.player).passes++;
        this.#rate(att, passer.player, RATING.pass);
      }
    }
    if (rng.chance(clamp(0.117 * this.#meanMod(def, 'tackleW'), 0.02, 0.4))) {
      const tackler = this.#pick(def, TACKLE_WEIGHT, ['DF', 'MF', 'FW'], 'tackleW');
      if (tackler && rng.chance(0.45 + (attrOf(tackler.player, 'tackling') / 99) * 0.4)) {
        this.#line(def, tackler.player).tackles++;
        this.#rate(def, tackler.player, RATING.tackle);
      }
    }
  }

  // The EE-5 minute: TICKS_PER_MINUTE zone-transition rolls. Strengths are
  // computed once per minute (they only move between minutes — fatigue,
  // cards, subs). Chances open only in the owner's final third; a spell of
  // held final-third ticks keeps re-opening the gate, which is where
  // pressure — and shot clustering — comes from. Conversion per shot is
  // untouched, so goals stay near-Poisson.
  #phaseBallFlow(ctx) {
    const { rng, minute } = ctx;
    const minuteTerr = { A: 0, D: 0 };
    const str = {};
    for (const key of ['home', 'away']) {
      const side = this.sides[key];
      str[key] = {
        midfield: this.#strength(side, 'midfield'),
        attack: this.#strength(side, 'attack'),
        defense: this.#strength(side, 'defense'),
      };
    }

    for (let tick = 0; tick < TICKS_PER_MINUTE; tick++) {
      const wasFinalThird = this.#inFinalThird();
      const roll = rng.weightedPick(this.#tickWeights(str));
      if (roll === 'advance' && this.#ownerZone() !== 'A') {
        const dir = this.ball.owner === 'home' ? 1 : -1;
        this.ball.zone = ZONES[ZONES.indexOf(this.ball.zone) + dir];
      } else if (roll === 'turnover') {
        this.ball.owner = this.ball.owner === 'home' ? 'away' : 'home';
      }

      const owner = this.sides[this.ball.owner];
      owner.ownedTicks++;
      if (this.ball.zone !== 'M') {
        this.zoneTicks[this.ball.zone]++;
        minuteTerr[this.ball.zone]++;
      }
      if (this.#inFinalThird() && !(wasFinalThird && roll !== 'turnover')) {
        owner.stats.finalThirdEntries++;
      }
      this.flow.push({ minute, tick, zone: this.ball.zone, owner: this.ball.owner });

      this.#tickBuildUp(rng);

      if (this.#inFinalThird() && rng.chance(this.#tickChanceProb(str))) {
        const attackerKey = this.ball.owner;
        const defenderKey = attackerKey === 'home' ? 'away' : 'home';
        const outcome = this.#resolveChance(
          attackerKey, this.sides[attackerKey], defenderKey, this.sides[defenderKey]);
        if (outcome.goal) {
          this.ball = { zone: 'M', owner: defenderKey }; // conceder kicks off
        } else if (!outcome.corner) {
          // Cleared, held, or dead: the defenders restart from their third.
          this.ball = {
            zone: defenderKey === 'home' ? 'D' : 'A',
            owner: defenderKey,
          };
        } // corner: the attackers keep the pressure on in the final third
      }
    }

    this.#terrWindow.push(minuteTerr);
    if (this.#terrWindow.length > MOMENTUM_WINDOW) this.#terrWindow.shift();
  }

  // Fouls and cards.
  #phaseDiscipline(ctx) {
    const { minute, rng } = ctx;
    for (const [key, side] of Object.entries(this.sides)) {
      // Pressing sides commit more fouls, and their pressers commit them.
      if (!rng.chance(clamp(0.11 * this.#meanMod(side, 'foulCh'), 0.02, 0.4))) continue;
      side.stats.fouls++;
      const offEntry = this.#pick(side, { DF: 1, MF: 1, FW: 1 }, ['DF', 'MF', 'FW'], 'foulCh');
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
          (1.30 - attrOf(e.player, 'stamina') / 165) * e.mods.decay;
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

  // Zone-flavoured build-up pool (BALL-09): a long stay in the final third
  // reads as pressure; a fresh arrival from deep reads as a break. Pool
  // choice is a pure function of the flow log — the pick is one draw as
  // ever, so the RNG structure is unchanged by flavour.
  #chanceBuildPool() {
    const n = this.flow.length;
    if (n >= 4) {
      const recent = this.flow.slice(n - 4);
      const owner = recent[3].owner;
      const settled = recent.every((f) => f.owner === owner &&
        (owner === 'home' ? f.zone === 'A' : f.zone === 'D'));
      if (settled) return COMMENTARY.chanceCamped;
      const deep = recent.some((f) =>
        f.owner === owner && (owner === 'home' ? f.zone === 'D' : f.zone === 'A'));
      if (deep) return COMMENTARY.chanceBreak;
    }
    return COMMENTARY.chanceBuild;
  }

  // Resolve a chance for the attacker. Returns { goal, corner } so the
  // ball model (EE-5) can place the restart.
  #resolveChance(attackerKey, att, defenderKey, def) {
    const rng = this.rng;
    const minute = this.minute;
    const shooterEntry = this.#pick(att, SHOOT_WEIGHT, ['DF', 'MF', 'FW'], 'shootW');
    if (!shooterEntry) return { goal: false, corner: false };
    const shooter = shooterEntry.player;

    att.stats.shots++;
    this.#line(att, shooter).shots++;
    this.#log(minute, 'chance', attackerKey, shooter,
      fill(rng.pick(this.#chanceBuildPool()), {
        player: shooter.name,
        team: att.setup.name,
        opponent: def.setup.name,
      }),
      { playerId: pid(shooter), zone: this.ball.zone });

    const missProb = clamp(0.42 - attrOf(shooter, 'finishing') * 0.0015, 0.2, 0.4);
    if (rng.chance(missProb)) {
      this.#rate(att, shooter, RATING.shotOff);
      this.#log(minute, 'miss', attackerKey, shooter,
        fill(rng.pick(COMMENTARY.miss), { player: shooter.name }),
        { playerId: pid(shooter) });
      return { goal: false, corner: false };
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
        return { goal: false, corner: true };
      }
      return { goal: false, corner: false };
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
          providers.map((e) => ({
            item: e,
            weight: (ASSIST_WEIGHT[unitOf(e.slot)] ?? 1) * e.mods.assistW,
          }))
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
      return { goal: true, corner: false };
    }
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
      return { goal: false, corner: true };
    }
    return { goal: false, corner: false };
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

    const owned = this.sides.home.ownedTicks + this.sides.away.ownedTicks;
    this.sides.home.stats.possession = Math.round(
      (this.sides.home.ownedTicks / Math.max(1, owned)) * 100);
    this.sides.away.stats.possession = 100 - this.sides.home.stats.possession;

    // Territory (EE-5): share of final-third ticks spent in each side's
    // attacking third, regardless of who had the ball there.
    const thirds = this.zoneTicks.A + this.zoneTicks.D;
    this.sides.home.stats.territoryPct = thirds === 0 ? 50 :
      Math.round((this.zoneTicks.A / thirds) * 100);
    this.sides.away.stats.territoryPct = 100 - this.sides.home.stats.territoryPct;
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
      flow: this.flow,
    };
  }
}

export function simulateMatch(home, away, options = {}) {
  return new MatchSim(home, away, options).finish();
}
