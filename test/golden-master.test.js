// Golden-master regression tests (EE-1).
//
// Each fixture pins the exact output of a seeded match. A coreSha256
// mismatch means the simulation itself changed (RNG order, probabilities,
// stats); a sha256-only mismatch means event payloads changed. Either way,
// an unintentional difference is a bug; an intentional one is re-pinned
// deliberately via: npm run golden:update -- --reason "..."

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GOLDEN_CASES, runCase } from './golden/setups.js';
import { canonicalHashes, eventDigest, firstDivergence } from './golden/util.js';

const fixtures = JSON.parse(
  readFileSync(new URL('./golden/fixtures.json', import.meta.url), 'utf8')
);

test('fixtures cover every golden case', () => {
  assert.deepEqual(
    fixtures.cases.map((c) => c.name).sort(),
    GOLDEN_CASES.map((c) => c.name).sort()
  );
  assert.ok(fixtures.header.reason, 'fixture header must record a re-pin reason');
});

for (const pinned of fixtures.cases) {
  test(`golden › ${pinned.name}`, () => {
    const spec = GOLDEN_CASES.find((c) => c.name === pinned.name);
    const result = runCase(spec);
    const { sha256, coreSha256 } = canonicalHashes(result);
    const score = `${result.score.home}-${result.score.away}` +
      (result.shootout ? ` (${result.shootout.home}-${result.shootout.away} pens)` : '');

    const context = () => [
      `pinned:  score ${pinned.score} · ${pinned.eventCount} events`,
      `         (pinned ${fixtures.header.generated}: ${fixtures.header.reason})`,
      `current: score ${score} · ${result.events.length} events`,
      firstDivergence(pinned.eventDigest, eventDigest(result)),
      '→ intentional change? run: npm run golden:update -- --reason "..."',
    ].join('\n');

    assert.equal(coreSha256, pinned.coreSha256,
      `simulation core diverged from golden\n${context()}`);
    assert.equal(sha256, pinned.sha256,
      `event payloads diverged from golden (core identical)\n${context()}`);
  });
}
