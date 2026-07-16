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
const URL = process.env.CHAMPMAN_TEST_URL ?? 'http://127.0.0.1:8123/';
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

  const { default: worldSize } = await import('./world-size.js');
  const teamCount = await page.$$eval('#team-rows tr', (rows) => rows.length);
  assert.equal(teamCount, worldSize.clubs,
    `expected ${worldSize.clubs} clubs across two divisions, got ${teamCount}`);
  await page.hover('#team-rows tr:nth-child(5)');
  const squadCount = await page.$$eval('#squad-rows tr', (rows) => rows.length);
  assert.equal(squadCount, 18, `squad panel shows ${squadCount} players`);
  console.log(`✔ start screen: ${worldSize.clubs} clubs in two divisions, 18-player squads on hover`);
  await shot('01-start');

  await page.$eval('#manager-name', (el) => { el.value = ''; });
  await page.type('#manager-name', 'Test Gaffer');
  // Row 5: a mid-table Division 1 club, whichever club that is in the data.
  const pickedClub = await page.$eval('#team-rows tr:nth-child(5)',
    (row) => row.querySelector('td')?.textContent.trim() ?? row.textContent.trim());
  await page.click('#team-rows tr:nth-child(5)');
  await page.waitForSelector('#hub-screen:not([hidden])');

  const hud = await page.$eval('#hud', (el) => el.textContent);
  assert.ok(hud.includes(pickedClub) && hud.includes('Test Gaffer'), hud);
  const welcome = await page.$eval('.news-item', (el) => el.textContent);
  assert.ok(welcome.includes('Welcome'), 'no welcome news');
  console.log('✔ career started, hub + inbox render');
  await shot('02-inbox');

  // --- Hub screens ------------------------------------------------------------
  await page.click('.nav-btn[data-screen="squad"]');
  const squadRows = await page.$$eval('#hub-content tbody tr', (r) => r.length);
  assert.equal(squadRows, 18, `squad screen shows ${squadRows}`);
  // EE-2: POS column carries detailed positions, not just unit families.
  const posLabels = await page.$$eval('#hub-content tbody tr td:first-child',
    (cells) => cells.map((c) => c.textContent.trim()));
  assert.ok(posLabels.every((l) => /^(GK|DR|DC|DL|DM|MR|MC|ML|AMC|ST)(\/|$)/.test(l)),
    `unexpected position labels: ${posLabels.join(' ')}`);
  assert.ok(posLabels.some((l) => l.includes('/')), 'no secondary positions shown in squad');
  console.log('✔ squad screen lists 18 players with detailed positions');
  await shot('03-squad');

  // EE-3: clicking a player opens the attribute profile, exact for own players.
  await page.click('#hub-content .player-link');
  await page.waitForSelector('#profile-overlay');
  const attrLines = await page.$$eval('#profile-overlay .attr-line', (els) => els.length);
  assert.ok(attrLines >= 6, `profile shows only ${attrLines} attribute lines`);
  const exactVals = await page.$$eval('#profile-overlay .attr-val', (els) =>
    els.filter((e) => /^\d+$/.test(e.textContent.trim())).length);
  assert.ok(exactVals >= 6, 'own player attributes should be exact');
  await shot('03b-profile');
  await page.click('#profile-close');
  await page.waitForFunction(() => !document.getElementById('profile-overlay'));
  console.log('✔ player profile shows the eight attributes exactly for own players');

  await page.click('.nav-btn[data-screen="tactics"]');
  const xiRows = await page.$$eval('[data-swap^="starters"]', (r) => r.length);
  assert.equal(xiRows, 11);
  // Swap two starters and confirm the change sticks.
  // The name is the cell's first text node; status/OOP tags follow in spans.
  const nameOf = (el) => el.childNodes[0].textContent.trim();
  const firstName = await page.$eval('[data-swap="starters:1"] td:nth-child(2)', nameOf);
  await page.click('[data-swap="starters:1"]');
  await page.click('[data-swap="starters:2"]');
  const swappedName = await page.$eval('[data-swap="starters:2"] td:nth-child(2)', nameOf);
  assert.equal(firstName, swappedName, 'swap did not move the player');
  // EE-2 (POS-10): the displaced starter is flagged out of position.
  const oopTags = await page.$$eval('[data-swap^="starters"] .status-tag.ban',
    (els) => els.map((e) => e.textContent.trim()));
  assert.ok(oopTags.some((t) => t.includes('▸')), `no amber OOP tag after swap: ${oopTags.join(' ')}`);
  // Change formation.
  await page.select('#formation-select', '4-3-3');
  await page.waitForFunction(() =>
    document.querySelectorAll('[data-swap^="starters"]').length === 11);
  const fwCount = await page.$$eval('[data-swap^="starters"]', (rows) =>
    rows.filter((r) => r.children[0].textContent === 'ST').length);
  assert.equal(fwCount, 3, '4-3-3 should start 3 strikers');
  console.log('✔ tactics: swaps work, formation changes reshape the XI');

  // EE-4: click a pitch marker, set an instruction, see the arrow.
  const tacChips = await page.$$eval('[data-instr-slot]', (els) => els.length);
  assert.equal(tacChips, 11, `tactics pitch shows ${tacChips} markers`);
  await page.click('[data-instr-slot="0"]'); // the keeper
  const gkPanel = await page.$eval('#instr-panel', (el) => el.textContent);
  assert.ok(gkPanel.includes('Keeper instructions are fixed'), gkPanel);
  await page.click('[data-instr-slot="1"]'); // DR
  await page.waitForSelector('#instr-panel [data-axis]');
  await page.click('#instr-panel [data-axis="runs"][data-value="forward"]');
  await page.waitForSelector('[data-instr-slot="1"] .ia-fwd');
  const balance = await page.$eval('#balance-strip', (el) => el.textContent);
  assert.ok(balance.includes('right flank'), `balance strip: ${balance}`);
  console.log('✔ EE-4 tactics: click panel sets forward runs, arrow + balance strip update');

  // 12 · DRG-01: drag the DR marker onto the DL marker — players swap
  // slots, and the forward-runs instruction stays with the DR slot.
  const dragChip = async (fromSel, toSel) => {
    const from = await (await page.$(fromSel)).boundingBox();
    const to = await (await page.$(toSel)).boundingBox();
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 10 });
    await page.mouse.up();
  };
  const starterName = (i) =>
    page.$eval(`[data-swap="starters:${i}"] td:nth-child(2)`,
      (el) => el.childNodes[0].textContent.trim());
  const drBefore = await starterName(1);
  const dlBefore = await starterName(4);
  await dragChip('[data-instr-slot="1"]', '[data-instr-slot="4"]');
  await page.waitForFunction((expected) => {
    const row = document.querySelector('[data-swap="starters:1"] td:nth-child(2)');
    return row && row.childNodes[0].textContent.trim() === expected;
  }, {}, dlBefore);
  assert.equal(await starterName(4), drBefore, 'drag did not swap the players');
  const arrowStays = await page.$('[data-instr-slot="1"] .ia-fwd');
  assert.ok(arrowStays, 'forward-runs instruction must stay with the DR slot after a drag');
  console.log('✔ 12: drag on the tactics pitch swaps players; instruction stays with the slot');
  await shot('04-tactics');

  await page.click('.nav-btn[data-screen="table"]');
  const tableRows = await page.$$eval('#hub-content tbody tr', (r) => r.length);
  assert.equal(tableRows, worldSize.clubs, `both division tables should render (${tableRows} rows)`);
  const panels = await page.$$eval('#hub-content .panel-title', (els) => els.map((e) => e.textContent));
  assert.ok(panels.some((p) => p.includes('Division 1')) && panels.some((p) => p.includes('Division 2')),
    'missing division panels');
  await page.click('.nav-btn[data-screen="fixtures"]');
  const fixtureRows = await page.$$eval('#hub-content tbody tr', (r) => r.length);
  assert.equal(fixtureRows, worldSize.seasonWeeks, `calendar shows ${fixtureRows} weeks`);
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
    (cells) => cells.every((c) => /^(DM|MR|MC|ML|AMC)/.test(c.textContent.trim())));
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

  // EE-3: an unscouted player's profile ranges every attribute.
  await page.click('#hub-content .player-link');
  await page.waitForSelector('#profile-overlay');
  const rangedAttrs = await page.$$eval('#profile-overlay .attr-val', (els) =>
    els.filter((e) => /\d+–\d+/.test(e.textContent)).length);
  assert.ok(rangedAttrs >= 6, `expected per-attribute ranges, got ${rangedAttrs}`);
  await shot('05b-scout-profile');
  await page.click('#profile-close');
  await page.waitForFunction(() => !document.getElementById('profile-overlay'));
  console.log('✔ unscouted profile shows per-attribute estimate ranges');

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
  // EE-2: chips sit at formation slot coordinates — 22 distinct spots.
  const chipSpots = await page.$$eval('#pitch-players .chip',
    (els) => els.map((e) => `${e.style.left}|${e.style.top}`));
  assert.equal(new Set(chipSpots).size, 22, 'pitch chips overlap');

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

  // EE-4: while paused, click an own outfield marker and set the press.
  const ownChips = await page.$$('.own-chip');
  assert.equal(ownChips.length, 11, `expected 11 own markers, got ${ownChips.length}`);
  await ownChips[2].click(); // onPitch[2]: an outfield defender
  await page.waitForSelector('#match-instr:not([hidden]) [data-axis]');
  await page.click('#match-instr [data-axis="press"][data-value="high"]');
  const instrLine = await page.$eval('#commentary li:last-child', (el) => el.textContent);
  assert.ok(instrLine.includes('told to press high'), `no instruction commentary: ${instrLine}`);
  const arrowShown = await page.$$eval('.own-chip .ia-high', (els) => els.length);
  assert.ok(arrowShown >= 1, 'no press-high arrow on the pitch');
  console.log('✔ EE-4 match: paused click panel sets pressing, commentary + arrow confirm');

  // 12 · DRG-02: drag one own outfield marker onto another while paused —
  // the swap happens live in the sim and hits the commentary.
  const own = await page.$$('.own-chip');
  const boxA = await own[3].boundingBox();
  const boxB = await own[7].boundingBox();
  await page.mouse.move(boxA.x + boxA.width / 2, boxA.y + boxA.height / 2);
  await page.mouse.down();
  await page.mouse.move(boxB.x + boxB.width / 2, boxB.y + boxB.height / 2, { steps: 10 });
  await page.mouse.up();
  await page.waitForFunction(() =>
    document.querySelector('#commentary li:last-child')?.textContent.includes('swap positions'));
  console.log('✔ 12: drag on the match pitch swaps positions live (commentary confirms)');
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
  assert.equal(played, worldSize.clubs, 'every club should show 1 played after round 1');
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

  // EE-4: the forward-runs instruction set before the match survived the save.
  await page.click('.nav-btn[data-screen="tactics"]');
  await page.waitForSelector('[data-instr-slot="1"] .ia-fwd');
  console.log('✔ EE-4: instruction persisted through save/reload');

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
