// Regenerates the golden-master fixtures from the current engine.
//
//   npm run golden:update -- --reason "why the pinned behaviour changed"
//
// Re-pinning is a deliberate act: the tool refuses to run without a reason,
// records it in the fixture header, and prints an old→new diff summary so
// the change is reviewable in the PR.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { GOLDEN_CASES, runCase } from '../test/golden/setups.js';
import { canonicalHashes, eventDigest } from '../test/golden/util.js';

const FIXTURES_PATH = fileURLToPath(new URL('../test/golden/fixtures.json', import.meta.url));

const reasonIdx = process.argv.indexOf('--reason');
const reason = reasonIdx !== -1 ? process.argv[reasonIdx + 1] : null;
if (!reason || reason.startsWith('--')) {
  console.error('refusing to re-pin goldens without a reason.');
  console.error('usage: npm run golden:update -- --reason "EE-N: what changed and why"');
  process.exit(1);
}

let old = null;
try {
  old = JSON.parse(readFileSync(FIXTURES_PATH, 'utf8'));
} catch {
  // first generation
}
const oldByName = new Map((old?.cases ?? []).map((c) => [c.name, c]));

const cases = GOLDEN_CASES.map((c) => {
  const result = runCase(c);
  const { sha256, coreSha256 } = canonicalHashes(result);
  return {
    name: c.name,
    seed: c.seed,
    kind: c.kind,
    knockout: c.knockout ?? false,
    score: `${result.score.home}-${result.score.away}` +
      (result.shootout ? ` (${result.shootout.home}-${result.shootout.away} pens)` : ''),
    eventCount: result.events.length,
    sha256,
    coreSha256,
    eventDigest: eventDigest(result),
  };
});

const pad = (s, n) => String(s).padEnd(n);
console.log(pad('case', 34) + pad('score', 22) + pad('events', 12) + 'change');
for (const c of cases) {
  const prev = oldByName.get(c.name);
  const score = prev && prev.score !== c.score ? `${prev.score} → ${c.score}` : c.score;
  const events = prev && prev.eventCount !== c.eventCount
    ? `${prev.eventCount} → ${c.eventCount}` : `${c.eventCount}`;
  const change = !prev ? 'new'
    : prev.sha256 === c.sha256 ? 'unchanged'
    : prev.coreSha256 === c.coreSha256 ? 're-pinned (payloads only; core identical)'
    : 're-pinned (CORE CHANGED)';
  console.log(pad(c.name, 34) + pad(score, 22) + pad(events, 12) + change);
}

writeFileSync(FIXTURES_PATH, JSON.stringify({
  header: {
    generated: new Date().toISOString().slice(0, 10),
    reason,
    note: 'Pinned engine behaviour. Regenerate only deliberately, with a reason: npm run golden:update -- --reason "..."',
  },
  cases,
}, null, 1) + '\n');
console.log(`\n${cases.length} fixtures written · reason: ${reason}`);
