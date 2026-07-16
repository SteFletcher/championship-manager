import test from 'node:test';
import assert from 'node:assert/strict';
import { runCareer, runPlaytestSuite, DEFAULT_PLAYTEST } from './harness.js';
import { policyById } from './policies.js';
import { assessFun, baselineFailures } from './fun.js';

const sessions = runPlaytestSuite();
const assessment = assessFun(sessions);

test('rule-based managers complete five functional seasons', () => {
  for (const session of sessions) {
    assert.equal(session.completedSeasons, DEFAULT_PLAYTEST.seasons, `${session.policy} career ended early`);
    assert.equal(session.history.length, DEFAULT_PLAYTEST.seasons);
    assert.ok(session.matches.length > 100, `${session.policy} played too few matches`);
    assert.ok(Number.isFinite(session.final.balance), `${session.policy} has an invalid balance`);
    assert.ok(session.final.playerIds.length >= 16, `${session.policy} has an invalid squad`);
    for (const season of session.history) {
      assert.ok(season.champion && season.champion2 && season.cupWinner);
      assert.ok(season.userPosition > 0);
      assert.equal(season.promoted.length, 2);
      assert.equal(season.relegated.length, 2);
    }
  }
});

test('playtest decisions exercise management and live match systems', () => {
  const adaptive = sessions.find((session) => session.policy === 'adaptive');
  const types = new Set([
    ...adaptive.managementActions.filter((item) => item.ok).map((item) => item.type),
    ...adaptive.matches.flatMap((match) => match.actions.filter((item) => item.ok).map((item) => item.type)),
  ]);
  for (const expected of ['contract', 'scout', 'pre-match-tactics', 'tactics', 'instruction', 'substitution']) {
    assert.ok(types.has(expected), `adaptive policy never exercised ${expected}`);
  }
});

test('same seed and policy replay the identical career', () => {
  const options = { seasons: 1, seed: 0x12345678 };
  const first = runCareer(policyById('adaptive'), options);
  const replay = runCareer(policyById('adaptive'), options);
  assert.deepEqual(replay, first);
});

test('FUN indicators stay above the checked-in regression baseline', () => {
  const failures = baselineFailures(assessment);
  assert.deepEqual(failures, [], `${failures.join('; ')}\n${JSON.stringify(assessment, null, 2)}`);
});
