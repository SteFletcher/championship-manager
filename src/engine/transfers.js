// Transfer market logic: valuations, negotiation, and AI behaviour.
// Pure functions; the game layer owns the state changes.

import { ability, fairWage, fairValue } from './players.js';

export const MIN_SQUAD = 15;
export const MIN_GKS = 2;

// What the selling club wants for the player. Listed players go cheaper;
// key players attract a premium.
export function askingPrice(club, player) {
  const premium = player.listed ? 0.85 : 1.2;
  const squadBest = Math.max(...club.players.map((p) => ability(p)));
  const keyPlayer = ability(player) >= squadBest - 3 ? 1.25 : 1;
  return Math.round((player.value * premium * keyPlayer) / 5000) * 5000;
}

// Would selling break the squad? Clubs refuse to sell below a floor.
export function canRelease(club, player) {
  if (club.players.length <= MIN_SQUAD) return false;
  if (player.pos === 'GK') {
    return club.players.filter((p) => p.pos === 'GK').length > MIN_GKS;
  }
  return true;
}

// Evaluate a bid. Returns { status: 'accepted'|'countered'|'rejected', counter? }.
export function evaluateBid(club, player, amount) {
  if (!canRelease(club, player)) return { status: 'rejected', reason: 'squad too thin' };
  const asking = askingPrice(club, player);
  if (amount >= asking) return { status: 'accepted' };
  if (amount >= player.value * 0.9) {
    return {
      status: 'countered',
      counter: Math.round(((asking + amount) / 2) / 5000) * 5000,
    };
  }
  return { status: 'rejected', reason: 'derisory offer' };
}

// The player's contract demands when joining a new club.
export function wageDemand(player, fromTier, toTier) {
  let demand = Math.max(player.wage * 1.1, fairWage(player));
  if (toTier < fromTier - 5) demand *= 1.35; // pay me to step down
  return Math.round(demand / 10) * 10;
}

// Will the player agree to the move at all?
export function playerAgrees(rng, player, fromTier, toTier) {
  if (toTier >= fromTier - 4) return true;
  // Reluctant to drop down; more so at his peak.
  const dropFactor = (fromTier - toTier) / 40;
  return !rng.chance(Math.min(0.85, 0.35 + dropFactor));
}

// How much an AI club covets a player: needs in that position plus quality.
export function aiInterest(club, player) {
  const samePos = club.players.filter((p) => p.pos === player.pos);
  const bestThere = Math.max(...samePos.map((p) => ability(p)), 0);
  const upgrade = ability(player) - bestThere;
  const thin = samePos.length < (player.pos === 'GK' ? 2 : 4) ? 0.3 : 0;
  return Math.max(0, upgrade / 20) + thin;
}

// The fee an AI club offers when it comes in for a player.
export function aiOfferAmount(rng, player) {
  return Math.round((player.value * (0.9 + rng.next() * 0.5)) / 5000) * 5000;
}

// Free-agent signing: no fee, but wage demands apply.
export function freeAgentWage(player) {
  return Math.round((fairWage(player) * 1.05) / 10) * 10;
}
