// EE-1 phase-pipeline and structured-event tests.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MatchSim, simulateMatch } from '../src/engine/match.js';
import { makeXi } from './golden/setups.js';

const home = makeXi('Phase Home', 72);
const away = makeXi('Phase Away', 72);

test('every event carries a machine-readable data payload', () => {
  const seen = new Set();
  for (let seed = 0; seed < 30; seed++) {
    const r = simulateMatch(home, away, { seed, timeline: false, knockout: seed < 5 });
    for (const e of r.events) {
      seen.add(e.type);
      assert.ok(e.data && typeof e.data === 'object',
        `${e.type} event at minute ${e.minute} has no data payload`);
      if (e.type === 'goal') {
        assert.ok(e.data.playerId, 'goal missing scorer id');
        assert.ok('assistId' in e.data, 'goal missing assistId field');
        assert.ok(Number.isInteger(e.data.score?.home) && Number.isInteger(e.data.score?.away),
          'goal missing running score');
      }
      if (e.type === 'save') {
        assert.ok(e.data.shooterId && 'keeperId' in e.data, 'save missing shooter/keeper ids');
      }
      if (e.type === 'injury') {
        assert.ok(e.data.playerId && e.data.weeks >= 1, 'injury missing player/weeks');
      }
      if (['foul', 'yellow', 'red', 'chance', 'miss', 'block'].includes(e.type)) {
        assert.ok(e.data.playerId, `${e.type} missing playerId`);
      }
    }
  }
  // The sample must actually exercise the payloads we assert on.
  for (const type of ['goal', 'save', 'foul', 'yellow', 'chance', 'miss']) {
    assert.ok(seen.has(type), `no ${type} events in sample — weak test`);
  }
});

test('substitution events carry both player ids', () => {
  const withBench = {
    ...home,
    bench: [{ id: 'PH-b1', name: 'PH SubMF', pos: 'MF', atk: 64, def: 64 }],
  };
  const sim = new MatchSim(withBench, away, { seed: 3, autoSubs: { home: false, away: false } });
  for (let i = 0; i < 20; i++) sim.playMinute();
  const offId = sim.sides.home.onPitch[6].player.id;
  assert.equal(sim.makeSub('home', offId, 'PH-b1').ok, true);
  const subEvent = sim.events.find((e) => e.type === 'sub');
  assert.deepEqual(subEvent.data, { onId: 'PH-b1', offId });
  sim.finish();
});

test('the phase list is the loop: removing a phase skips exactly that behaviour', () => {
  class NoDiscipline extends MatchSim {
    static MINUTE_PHASES = MatchSim.MINUTE_PHASES.filter((p) => p !== 'discipline');
  }
  const stripped = new NoDiscipline(home, away, { seed: 11, timeline: false }).finish();
  assert.equal(stripped.stats.home.fouls + stripped.stats.away.fouls, 0);
  assert.ok(!stripped.events.some((e) => ['foul', 'yellow', 'red'].includes(e.type)));
  // Everything else still ran: the match completed with shots and a timeline of minutes.
  assert.ok(stripped.playedMinutes >= 90);
  assert.ok(stripped.stats.home.shots + stripped.stats.away.shots > 0);

  // Control: the intact pipeline produces fouls over the same seeds.
  const control = simulateMatch(home, away, { seed: 11, timeline: false });
  assert.ok(control.stats.home.fouls + control.stats.away.fouls > 0);
});

test('phases share one context: chance creation consumes the possession winner', () => {
  const perMinute = [];
  let current = null;
  const sim = new MatchSim(home, away, {
    seed: 17,
    timeline: false,
    phaseHook: (name, ctx) => {
      if (name === 'possession') current = { ctx, attacker: ctx.attackerKey };
      if (name === 'chanceCreation') {
        perMinute.push({
          sameObject: ctx === current.ctx,
          sameAttacker: ctx.attackerKey === current.attacker,
          validAttacker: ['home', 'away'].includes(ctx.attackerKey),
        });
      }
    },
  });
  sim.simulateToEnd();
  assert.equal(perMinute.length, sim.minute);
  assert.ok(perMinute.every((m) => m.sameObject && m.sameAttacker && m.validAttacker));
});

test('an observational phase hook does not change the result', () => {
  const hooked = new MatchSim(home, away, { seed: 29, phaseHook: () => {} }).finish();
  const bare = new MatchSim(home, away, { seed: 29 }).finish();
  assert.deepEqual(hooked, bare);
});

test('golden updater refuses to run without a reason', () => {
  const tool = fileURLToPath(new URL('../tools/update-goldens.js', import.meta.url));
  for (const args of [[tool], [tool, '--reason'], [tool, '--reason', '--other-flag']]) {
    const run = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.notEqual(run.status, 0, `updater ran without a reason: ${args.join(' ')}`);
    assert.match(run.stderr, /reason/i);
  }
});
