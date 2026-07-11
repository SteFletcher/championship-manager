import test from 'node:test';
import assert from 'node:assert/strict';
import { createRng, hashString } from '../src/engine/rng.js';

test('same seed produces identical sequences', () => {
  const a = createRng(12345);
  const b = createRng(12345);
  for (let i = 0; i < 1000; i++) {
    assert.equal(a.next(), b.next());
  }
});

test('different seeds produce different sequences', () => {
  const a = createRng(1);
  const b = createRng(2);
  const seqA = Array.from({ length: 20 }, () => a.next());
  const seqB = Array.from({ length: 20 }, () => b.next());
  assert.notDeepEqual(seqA, seqB);
});

test('next() stays in [0, 1)', () => {
  const rng = createRng(999);
  for (let i = 0; i < 10000; i++) {
    const v = rng.next();
    assert.ok(v >= 0 && v < 1, `value out of range: ${v}`);
  }
});

test('next() is roughly uniform', () => {
  const rng = createRng(42);
  const buckets = new Array(10).fill(0);
  const n = 100000;
  for (let i = 0; i < n; i++) {
    buckets[Math.floor(rng.next() * 10)]++;
  }
  for (const count of buckets) {
    // Each decile should hold ~10% of samples; allow generous tolerance.
    assert.ok(Math.abs(count - n / 10) < n * 0.01, `skewed bucket: ${count}`);
  }
});

test('int(min, max) covers the full inclusive range and nothing outside', () => {
  const rng = createRng(7);
  const seen = new Set();
  for (let i = 0; i < 5000; i++) {
    const v = rng.int(3, 8);
    assert.ok(v >= 3 && v <= 8, `out of range: ${v}`);
    assert.ok(Number.isInteger(v));
    seen.add(v);
  }
  assert.deepEqual([...seen].sort(), [3, 4, 5, 6, 7, 8]);
});

test('chance(p) approximates p', () => {
  const rng = createRng(11);
  let hits = 0;
  const n = 50000;
  for (let i = 0; i < n; i++) if (rng.chance(0.3)) hits++;
  assert.ok(Math.abs(hits / n - 0.3) < 0.01, `observed ${hits / n}`);
});

test('chance edge cases: 0 never fires, 1 always fires', () => {
  const rng = createRng(5);
  for (let i = 0; i < 1000; i++) {
    assert.equal(rng.chance(0), false);
    assert.equal(rng.chance(1), true);
  }
});

test('pick only returns array members', () => {
  const rng = createRng(3);
  const items = ['a', 'b', 'c'];
  for (let i = 0; i < 1000; i++) {
    assert.ok(items.includes(rng.pick(items)));
  }
});

test('weightedPick respects weights', () => {
  const rng = createRng(21);
  const counts = { heavy: 0, light: 0 };
  for (let i = 0; i < 20000; i++) {
    counts[
      rng.weightedPick([
        { item: 'heavy', weight: 3 },
        { item: 'light', weight: 1 },
      ])
    ]++;
  }
  const ratio = counts.heavy / counts.light;
  assert.ok(ratio > 2.5 && ratio < 3.5, `ratio ${ratio}`);
});

test('hashString is deterministic and distinguishes strings', () => {
  assert.equal(hashString('Riverton Athletic'), hashString('Riverton Athletic'));
  assert.notEqual(hashString('Riverton Athletic'), hashString('Fenwick Rangers'));
  assert.ok(hashString('') >= 0);
});
