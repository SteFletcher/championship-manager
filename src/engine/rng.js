// Seeded pseudo-random number generator (mulberry32).
// Every source of randomness in the engine flows through one of these
// instances so a match can be replayed exactly from its seed.

export function createRng(seed) {
  let state = seed >>> 0;

  function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  return {
    /** Float in [0, 1). */
    next,
    /** Integer in [min, max] inclusive. */
    int(min, max) {
      return min + Math.floor(next() * (max - min + 1));
    },
    /** True with probability p. */
    chance(p) {
      return next() < p;
    },
    /** Uniform pick from a non-empty array. */
    pick(items) {
      return items[Math.floor(next() * items.length)];
    },
    /** Serializable generator state, for save games. */
    getState() {
      return state;
    },
    setState(s) {
      state = s >>> 0;
    },
    /** Weighted pick: items is [{item, weight}, ...] with weights > 0. */
    weightedPick(entries) {
      const total = entries.reduce((sum, e) => sum + e.weight, 0);
      let roll = next() * total;
      for (const entry of entries) {
        roll -= entry.weight;
        if (roll <= 0) return entry.item;
      }
      return entries[entries.length - 1].item;
    },
  };
}

// Deterministic 32-bit hash of a string, for deriving seeds from names.
export function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
