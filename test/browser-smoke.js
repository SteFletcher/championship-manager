// End-to-end browser smoke test for the career game. Not part of `npm test`
// (needs a local Chromium-family browser and the dev server on :8123).
//
//   npm run serve   # in another terminal
//   node test/browser-smoke.js [path-to-browser-binary]

import puppeteer from 'puppeteer-core';
import { strict as assert } from 'node:assert';

const BROWSER =
  process.argv[2] ??
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const URL = 'http://127.0.0.1:8123/';
const SHOTS = process.env.SHOT_DIR ?? '.';

const browser = await puppeteer.launch({
  executablePath: BROWSER,
  headless: 'new',
  args: ['--no-first-run', '--disable-extensions'],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1320, height: 940 });

  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  page.on('console', (msg) => {
    if (msg.type() === 'error') pageErrors.push(msg.text());
  });
  const shot = (name) => page.screenshot({ path: `${SHOTS}/${name}.png` });

  // --- Start a career ------------------------------------------------------
  await page.goto(URL, { waitUntil: 'networkidle0' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForSelector('#team-rows tr');

  const teamCount = await page.$$eval('#team-rows tr', (rows) => rows.length);
  assert.equal(teamCount, 24, `expected 24 clubs across two divisions, got ${teamCount}`);
  await page.hover('#team-rows tr:nth-child(5)');
  const squadCount = await page.$$eval('#squad-rows tr', (rows) => rows.length);
  assert.equal(squadCount, 18, `squad panel shows ${squadCount} players`);
  console.log('✔ start screen: 24 clubs in two divisions, 18-player squads on hover');
  await shot('01-start');

  await page.$eval('#manager-name', (el) => { el.value = ''; });
  await page.type('#manager-name', 'Test Gaffer');
  await page.click('#team-rows tr:nth-child(5)'); // Harton Villa, mid-table
  await page.waitForSelector('#hub-screen:not([hidden])');

  const hud = await page.$eval('#hud', (el) => el.textContent);
  assert.ok(hud.includes('Harton Villa') && hud.includes('Test Gaffer'), hud);
  const welcome = await page.$eval('.news-item', (el) => el.textContent);
  assert.ok(welcome.includes('Welcome'), 'no welcome news');
  console.log('✔ career started, hub + inbox render');
  await shot('02-inbox');

  // --- Hub screens ------------------------------------------------------------
  await page.click('.nav-btn[data-screen="squad"]');
  const squadRows = await page.$$eval('#hub-content tbody tr', (r) => r.length);
  assert.equal(squadRows, 18, `squad screen shows ${squadRows}`);
  console.log('✔ squad screen lists 18 players');
  await shot('03-squad');

  await page.click('.nav-btn[data-screen="tactics"]');
  const xiRows = await page.$$eval('[data-swap^="starters"]', (r) => r.length);
  assert.equal(xiRows, 11);
  // Swap two starters and confirm the change sticks.
  const firstName = await page.$eval('[data-swap="starters:1"] td:nth-child(2)', (el) => el.textContent.trim());
  await page.click('[data-swap="starters:1"]');
  await page.click('[data-swap="starters:2"]');
  const swappedName = await page.$eval('[data-swap="starters:2"] td:nth-child(2)', (el) => el.textContent.trim());
  assert.equal(firstName, swappedName, 'swap did not move the player');
  // Change formation.
  await page.select('#formation-select', '4-3-3');
  await page.waitForFunction(() =>
    document.querySelectorAll('[data-swap^="starters"]').length === 11);
  const fwCount = await page.$$eval('[data-swap^="starters"]', (rows) =>
    rows.filter((r) => r.children[0].textContent === 'FW').length);
  assert.equal(fwCount, 3, '4-3-3 should start 3 forwards');
  console.log('✔ tactics: swaps work, formation changes reshape the XI');
  await shot('04-tactics');

  await page.click('.nav-btn[data-screen="table"]');
  const tableRows = await page.$$eval('#hub-content tbody tr', (r) => r.length);
  assert.equal(tableRows, 24, `both division tables should render (${tableRows} rows)`);
  const panels = await page.$$eval('#hub-content .panel-title', (els) => els.map((e) => e.textContent));
  assert.ok(panels.some((p) => p.includes('Division 1')) && panels.some((p) => p.includes('Division 2')),
    'missing division panels');
  await page.click('.nav-btn[data-screen="fixtures"]');
  const fixtureRows = await page.$$eval('#hub-content tbody tr', (r) => r.length);
  assert.equal(fixtureRows, 27, `calendar shows ${fixtureRows} weeks`);
  await page.click('.nav-btn[data-screen="transfers"]');
  await page.waitForSelector('[data-bid]');
  await page.click('.nav-btn[data-screen="finances"]');
  assert.ok((await page.$eval('#hub-content', (el) => el.textContent)).includes('Balance'));
  await page.click('.nav-btn[data-screen="club"]');
  const clubText = await page.$eval('#hub-content', (el) => el.textContent);
  assert.ok(clubText.includes('Board confidence'));
  assert.ok(clubText.includes('Manager reputation'), 'club screen missing reputation');
  console.log('✔ table, fixtures, transfers, finances, club screens render');

  // --- Transfer flow ------------------------------------------------------------
  await page.click('.nav-btn[data-screen="transfers"]');
  await page.select('#filter-pos', 'MF');
  await page.waitForSelector('[data-bid]');
  const onlyMfs = await page.$$eval('#hub-content tbody tr td:first-child',
    (cells) => cells.every((c) => c.textContent === 'MF'));
  assert.ok(onlyMfs, 'position filter leaked other positions');
  const squadBefore = await page.evaluate(() => {
    return document.querySelectorAll('[data-bid]').length;
  });
  assert.ok(squadBefore > 0);
  await page.click('[data-bid]'); // bid asking price for the best MF
  await page.waitForFunction(() =>
    document.querySelector('.tactics-controls .gold, .tactics-controls .dim') !== null ||
    document.querySelector('.tactics-controls')?.textContent.match(/Signed|Countered|Rejected/));
  const note = await page.$eval('.tactics-controls', (el) => el.textContent);
  assert.match(note, /Signed|Countered|Rejected/, `transfer note: ${note}`);
  console.log(`✔ transfer bid flow responds (${note.match(/Signed[^.]*|Countered[^.]*|Rejected[^.]*/)?.[0]})`);

  // Attributes of other clubs' players are masked as ranges; scouting
  // dispatches a scout and notes it.
  const maskedCells = await page.$$eval('#hub-content tbody td.dim', (cells) =>
    cells.filter((c) => /^\d+–\d+$/.test(c.textContent.trim())).length);
  assert.ok(maskedCells > 0, 'no masked attribute ranges visible');
  await page.click('[data-scout]');
  await page.waitForFunction(() =>
    document.querySelector('.tactics-controls')?.textContent.includes('Scout dispatched'));
  const scoutingTags = await page.$$eval('#hub-content tbody td', (cells) =>
    cells.some((c) => c.textContent.includes('scouting…')));
  assert.ok(scoutingTags, 'no scouting-in-progress marker');
  console.log(`✔ attributes masked (${maskedCells} ranges) and scout dispatch works`);
  await shot('05-transfers');

  // --- Match day -----------------------------------------------------------------
  await page.click('#continue-btn');
  await page.waitForSelector('#prematch:not([hidden])');
  const xi = await page.$$eval('#prematch-xi tr', (r) => r.length);
  assert.equal(xi, 11);
  const oppXi = await page.$$eval('#opp-xi tr', (r) => r.length);
  assert.equal(oppXi, 11, 'opposition report missing predicted XI');
  const oppSummary = await page.$eval('#opp-summary', (el) => el.textContent);
  assert.ok(oppSummary.includes('Danger man'), `no danger man: ${oppSummary}`);
  console.log('✔ pre-match screen shows the XI and opposition report');
  await shot('06-prematch');

  await page.click('#play-match-btn');
  await page.waitForSelector('#matchday:not([hidden])');
  const chipCount = await page.$$eval('#pitch-players .chip', (els) => els.length);
  assert.equal(chipCount, 22);

  const att = await page.$eval('#score-att', (el) => el.textContent);
  assert.match(att, /^Att [\d,]+$/, `attendance missing from scoreboard: "${att}"`);
  assert.ok(parseInt(att.replace(/[^\d]/g, ''), 10) > 1000, `implausible gate: ${att}`);
  console.log(`✔ scoreboard shows the gate (${att})`);

  // Let the clock run, then pause and make a substitution.
  await new Promise((r) => setTimeout(r, 1600));
  const clock = await page.$eval('#score-clock', (el) => el.textContent);
  assert.ok(parseInt(clock) > 0, `clock stuck: ${clock}`);
  await page.click('#pause-btn');
  await page.waitForSelector('#sub-panel:not([hidden])');
  await page.click('#sub-off-list li:nth-child(11)'); // an outfielder
  await page.click('#sub-on-list li:first-child');
  await page.click('#make-sub-btn');
  const subLine = await page.$eval('#commentary li:last-child', (el) => el.textContent);
  assert.ok(subLine.includes('replaces'), `no sub commentary: ${subLine}`);
  console.log('✔ pause + manual substitution works mid-match');

  // Change tactics while paused: formation + mentality take effect live.
  await page.select('#match-formation', '5-3-2');
  await page.select('#match-mentality', 'defensive');
  const tacticsLine = await page.$eval('#commentary li:last-child', (el) => el.textContent);
  assert.ok(tacticsLine.includes('5-3-2') && tacticsLine.includes('defensive'),
    `no tactics commentary: ${tacticsLine}`);
  console.log('✔ mid-match tactics change (5-3-2, defensive) confirmed in commentary');
  await shot('07-match-paused-sub');

  await page.click('#pause-btn'); // resume

  // The match must auto-pause on key moments; half time is guaranteed.
  // (A red card or injury may pause it first — resume through those.)
  await page.click('.speed-btn[data-speed="60"]');
  let sawHalfTimePause = false;
  for (let i = 0; i < 8 && !sawHalfTimePause; i++) {
    await page.waitForFunction(
      () => document.getElementById('pause-reason').textContent !== '',
      { timeout: 15000 }
    );
    const reason = await page.$eval('#pause-reason', (el) => el.textContent);
    if (reason.includes('Half time')) sawHalfTimePause = true;
    else assert.match(reason, /Red card|injured|Extra time/, `unexpected pause: ${reason}`);
    if (!sawHalfTimePause) await page.click('#pause-btn'); // resume and keep going
  }
  assert.ok(sawHalfTimePause, 'match never auto-paused at half time');
  const panelOpen = await page.$eval('#sub-panel', (el) => !el.hidden);
  assert.ok(panelOpen, 'sub panel should open on auto-pause');
  console.log('✔ match auto-pauses at half time with the sub panel open');
  await shot('07b-halftime-pause');

  await page.click('#pause-btn'); // resume from half time
  await page.click('.speed-btn[data-speed="0"]'); // instant to full time
  await page.waitForSelector('#fulltime:not([hidden])', { timeout: 10000 });
  const motm = await page.$eval('#motm', (el) => el.textContent);
  assert.match(motm, /Man of the match/, motm);
  console.log('✔ match reaches full time with MOTM');
  await shot('08-fulltime');

  await page.click('#post-continue-btn');
  await page.waitForSelector('#hub-screen:not([hidden])');
  const summary = await page.$eval('#hub-content', (el) => el.textContent);
  assert.ok(summary.includes('results'), 'no week summary');
  const resultLines = await page.$$eval('#hub-content .news-body', (els) => els.length);
  assert.ok(resultLines >= 6, `only ${resultLines} results shown`);
  await page.click('.nav-btn[data-screen="table"]');
  const played = await page.$$eval('#hub-content tbody tr td:nth-child(3)',
    (cells) => cells.reduce((s, c) => s + Number(c.textContent), 0));
  assert.equal(played, 24, 'both tables should show 12 played each after round 1');
  console.log('✔ post-match: results recorded, both division tables updated');
  await shot('09-week-summary');

  await page.click('.nav-btn[data-screen="finances"]');
  const finances = await page.$eval('#hub-content', (el) => el.textContent);
  assert.ok(finances.includes('Fanbase') && finances.includes('supporters'),
    'finances missing fanbase');
  assert.ok(finances.includes('attendance'), 'finances missing attendance');
  assert.ok(finances.includes('Stadium expansion'), 'finances missing expansion panel');
  const expandUi = await page.$eval('#hub-content', (el) =>
    el.querySelector('#expand-btn') !== null || el.textContent.includes('Builders in'));
  assert.ok(expandUi, 'no expansion button or active project shown');
  console.log('✔ finances shows fanbase, attendance, and stadium expansion');
  await shot('10-finances');

  // --- Save / restore ----------------------------------------------------------------
  const hudBefore = await page.$eval('#hud', (el) => el.textContent);
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForSelector('#continue-save-btn:not([hidden])');
  await page.click('#continue-save-btn');
  await page.waitForSelector('#hub-screen:not([hidden])');
  const hudAfter = await page.$eval('#hud', (el) => el.textContent);
  assert.equal(hudAfter, hudBefore, 'save did not restore identical state');
  console.log('✔ save persists across a reload');

  // --- A couple more weeks headlessly via the UI -------------------------------------
  for (let i = 0; i < 2; i++) {
    await page.click('#continue-btn');
    await page.waitForSelector('#prematch:not([hidden]), #hub-content', { timeout: 5000 });
    const inMatch = await page.$eval('#prematch', (el) => !el.hidden).catch(() => false);
    if (inMatch) {
      await page.click('#play-match-btn');
      await page.click('.speed-btn[data-speed="0"]');
      await page.waitForSelector('#fulltime:not([hidden])', { timeout: 10000 });
      await page.click('#post-continue-btn');
      await page.waitForSelector('#hub-screen:not([hidden])');
    }
  }
  const hudWeek = await page.$eval('#hud', (el) => el.textContent);
  assert.match(hudWeek, /Week [34]/, `weeks did not advance: ${hudWeek}`);
  console.log(`✔ continued through further weeks (${hudWeek.match(/Week \d+/)[0]})`);

  const realErrors = pageErrors.filter((e) => !e.includes('favicon'));
  assert.deepEqual(realErrors, [], `browser errors:\n${realErrors.join('\n')}`);
  console.log('✔ no console or page errors');

  console.log('\nAll browser smoke checks passed.');
} finally {
  await browser.close();
}
