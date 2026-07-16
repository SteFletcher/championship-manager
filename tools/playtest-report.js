import { mkdir, writeFile } from 'node:fs/promises';
import { runPlaytestSuite } from '../test/playtest/harness.js';
import { assessFun, baselineFailures, FUN_BASELINE } from '../test/playtest/fun.js';

const sessions = runPlaytestSuite();
const assessment = assessFun(sessions);
const report = {
  deterministic: true,
  configuration: {
    seasonsPerPolicy: sessions[0].requestedSeasons,
    policies: sessions.map((session) => session.policy),
    seeds: Object.fromEntries(sessions.map((session) => [session.policy, session.seed])),
  },
  careers: sessions.map((session) => ({
    policy: session.policy,
    completedSeasons: session.completedSeasons,
    matches: session.matches.length,
    finalClub: session.final.clubName,
    finalReputation: session.final.reputation,
    jobs: session.jobs.length,
    campaigns: session.campaigns.length,
  })),
  baseline: FUN_BASELINE,
  assessment,
  failures: baselineFailures(assessment),
};

await mkdir('.playtest-results', { recursive: true });
await writeFile('.playtest-results/latest.json', `${JSON.stringify(report, null, 2)}\n`);

console.log('Deterministic career playtest');
console.table(report.careers);
console.log('FUN score:', assessment.overall);
console.table(assessment.components);
console.table(assessment.observations);
console.log(assessment.verdict);
console.log(assessment.caveat);
console.log('JSON report: .playtest-results/latest.json');

if (report.failures.length > 0) {
  console.error(`Regression baseline failed: ${report.failures.join('; ')}`);
  process.exitCode = 1;
}
