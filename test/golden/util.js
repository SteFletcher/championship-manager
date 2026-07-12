// Golden-master utilities: canonical serialization and hashing of match
// results. The "core" projection strips each event's additive `data` payload
// so the hash pins the simulation itself; the full hash additionally pins the
// structured payloads. A core mismatch means the engine's behaviour changed.

import { createHash } from 'node:crypto';

// JSON.stringify with sorted object keys, so hashes are stable regardless
// of property insertion order.
export function stableStringify(value) {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  }
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

export function sha256(str) {
  return createHash('sha256').update(str).digest('hex');
}

// Result minus each event's `data` field — the simulation core.
export function coreProjection(result) {
  return {
    ...result,
    events: result.events.map(({ data, ...rest }) => rest),
  };
}

export function canonicalHashes(result) {
  return {
    sha256: sha256(stableStringify(result)),
    coreSha256: sha256(stableStringify(coreProjection(result))),
  };
}

// Compact per-event fingerprint used to report the first divergence when a
// hash mismatches — turns "bytes differ" into "minute 63: foul vs corner".
export function eventDigest(result) {
  return result.events.map((e) => `${e.minute}:${e.type}:${e.side ?? '-'}`);
}

export function firstDivergence(pinned, current) {
  const n = Math.max(pinned.length, current.length);
  for (let i = 0; i < n; i++) {
    if (pinned[i] !== current[i]) {
      return `first divergence at event ${i}: pinned "${pinned[i] ?? '(none)'}" vs current "${current[i] ?? '(none)'}"`;
    }
  }
  return 'event digests identical (difference is in stats, timeline, or payloads)';
}
