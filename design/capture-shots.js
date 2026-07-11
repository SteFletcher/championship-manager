// Capture design screenshots of the running champman app.
// Usage: node design/capture-shots.js
// Requires: npm run serve (http://localhost:8123) already running.
import puppeteer from 'puppeteer-core';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BROWSER = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const URL = 'http://127.0.0.1:8123/';
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'screenshots');

const VIEWPORT = { width: 1280, height: 860, deviceScaleFactor: 2 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: BROWSER,
  headless: 'new',
  args: ['--no-first-run', '--disable-extensions', '--hide-scrollbars'],
});

const page = await browser.newPage();
await page.setViewport(VIEWPORT);
await mkdir(OUT, { recursive: true });

const shots = [];
function shot(name, desc) { shots.push({ name, desc }); }

// 1. Start / new-career screen.
await page.goto(URL, { waitUntil: 'networkidle0' });
await sleep(400);
// Hover a club row to populate the squad panel.
await page.evaluate(() => {
  const row = document.querySelector('#team-rows tr:nth-child(2)');
  if (row) row.dispatchEvent(new Event('mouseenter', { bubbles: true }));
});
await sleep(250);
await page.screenshot({ path: `${OUT}/01-start-screen.png` });
shot('01-start-screen', 'New career / team selection screen with squad inspector');

// 2. Start a career at a mid-table club (Harton Villa).
await page.evaluate(() => {
  const row = [...document.querySelectorAll('#team-rows tr')].find((r) =>
    r.dataset.team === 'Harton Villa');
  if (row) row.click();
});
await sleep(500);
await page.screenshot({ path: `${OUT}/02-inbox.png` });
shot('02-inbox', 'Management hub — Inbox (welcome message)');

async function nav(screen) {
  await page.evaluate((s) => {
    const btn = document.querySelector(`.nav-btn[data-screen="${s}"]`);
    if (btn) btn.click();
  }, screen);
  await sleep(350);
}

// 3. Squad
await nav('squad');
await page.screenshot({ path: `${OUT}/03-squad.png` });
shot('03-squad', 'Squad management — players, condition, form, morale, wages, contracts');

// 4. Tactics
await nav('tactics');
await page.screenshot({ path: `${OUT}/04-tactics.png` });
shot('04-tactics', 'Tactics — formation, mentality, XI/bench/reserves with click-to-swap');

// 5. Fixtures
await nav('fixtures');
await page.screenshot({ path: `${OUT}/05-fixtures.png` });
shot('05-fixtures', 'Fixtures & results calendar across the season');

// 6. League table
await nav('table');
await page.screenshot({ path: `${OUT}/06-table.png` });
shot('06-table', 'League tables — both divisions with promotion/relegation zones');

// 7. Cup
await nav('cup');
await page.screenshot({ path: `${OUT}/07-cup.png` });
shot('07-cup', 'The Cup — knockout bracket and round results');

// 8. Transfers
await nav('transfers');
await sleep(200);
await page.screenshot({ path: `${OUT}/08-transfers.png` });
shot('08-transfers', 'Transfer market — searchable, scouted, with attribute masking');

// 9. Finances
await nav('finances');
await page.screenshot({ path: `${OUT}/09-finances.png` });
shot('09-finances', 'Finances — balance, wages, gate receipts, stadium expansion');

// 10. Club & Board
await nav('club');
await page.screenshot({ path: `${OUT}/10-club-board.png` });
shot('10-club-board', 'Club & Board — confidence, reputation, expectation, history');

// 11. Pre-match screen — advance to a fixture via Continue.
await page.evaluate(() => document.getElementById('continue-btn').click());
await sleep(700);
await page.screenshot({ path: `${OUT}/11-prematch.png` });
shot('11-prematch', 'Pre-match — your line-up, bench, and opposition scouting report');

// 12. Live match day — kick off, let a few minutes play, then pause.
await page.evaluate(() => document.getElementById('play-match-btn').click());
await sleep(2600); // let ~8-10 minutes of commentary build up
// Pause to capture a stable mid-match frame with commentary + pitch.
await page.evaluate(() => document.getElementById('pause-btn').click());
await sleep(400);
await page.screenshot({ path: `${OUT}/12-matchday.png` });
shot('12-matchday', 'Live match day — scoreboard, commentary, formation pitch, player ratings');

// 13. Swap to the away tab on the player-stats table.
await page.evaluate(() => document.getElementById('tab-away').click());
await sleep(300);
await page.screenshot({ path: `${OUT}/13-matchday-away-stats.png` });
shot('13-matchday-away-stats', 'Match day — opposition player statistics tab');

// 14. Full time — run the match to the end with instant speed.
await page.evaluate(() => {
  const instant = document.querySelector('.speed-btn[data-speed="0"]');
  if (instant) instant.click();
});
await sleep(1200);
// If still not at full time (instant may need a resume), resume then wait.
await page.evaluate(() => {
  const btn = document.getElementById('pause-btn');
  if (btn && btn.textContent.includes('Resume')) btn.click();
});
await sleep(2500);
await page.screenshot({ path: `${OUT}/14-fulltime.png` });
shot('14-fulltime', 'Full time — scorers, man of the match, match statistics');

await browser.close();

// Emit a manifest the design docs can consume.
const manifest = shots.map((s) => ({ file: `${s.name}.png`, desc: s.desc }));
console.log(JSON.stringify(manifest, null, 2));
console.error(`\nCaptured ${shots.length} screenshots to ${OUT}`);
