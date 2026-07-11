// UI controller: career hub, team selection, and live match day.
// All game logic lives in src/engine; this file renders and paces it.

import { TEAMS } from '../src/data/teams.js';
import { teamRatings, overallRating, FORMATIONS, MENTALITIES } from '../src/engine/team.js';
import { ability, isAvailable } from '../src/engine/players.js';
import { Game } from '../src/engine/game.js';
import { cupRoundName, inCup } from '../src/engine/cup.js';

const $ = (id) => document.getElementById(id);
const SAVE_KEY = 'champman-save';

const state = {
  game: null,
  screen: 'inbox',
  lineup: null, // user-adjusted {starters, bench, formation} or null for auto
  swapSel: null, // tactics swap selection {list, index}
  match: null, // live match state
  transferFilters: { pos: '', maxValue: '' },
  transferNote: '',
};

// --- Formatting helpers ------------------------------------------------------

function money(n) {
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${sign}£${(abs / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  if (abs >= 1_000) return `${sign}£${Math.round(abs / 1000)}k`;
  return `${sign}£${abs}`;
}

function surname(name) {
  return name.split(' ').slice(-1)[0];
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function statusTags(p) {
  let tags = '';
  if (p.injuryWeeks > 0) tags += `<span class="status-tag inj">INJ ${p.injuryWeeks}w</span>`;
  if (p.banMatches > 0) tags += `<span class="status-tag ban">BAN ${p.banMatches}</span>`;
  if (p.listed) tags += `<span class="status-tag listed">LISTED</span>`;
  return tags;
}

function bar(value, low = 40, mid = 65) {
  const cls = value < low ? 'low' : value < mid ? 'mid' : '';
  return `<span class="bar ${cls}"><span style="width:${Math.round(value)}%"></span></span>`;
}

// --- Persistence ---------------------------------------------------------------

function saveGame(note = 'Game saved') {
  if (!state.game) return;
  try {
    localStorage.setItem(SAVE_KEY, state.game.serialize());
    $('save-note').textContent = note;
    setTimeout(() => { $('save-note').textContent = ''; }, 2500);
  } catch {
    $('save-note').textContent = 'Save failed';
  }
}

function loadGame() {
  const json = localStorage.getItem(SAVE_KEY);
  if (!json) return null;
  try {
    return Game.restore(json);
  } catch {
    return null;
  }
}

// --- Start screen ----------------------------------------------------------------

function renderStartScreen() {
  const tbody = $('team-rows');
  tbody.innerHTML = '';
  for (const team of TEAMS) {
    const r = teamRatings({ name: team.name, players: team.players.slice(0, 11) });
    const tr = document.createElement('tr');
    tr.tabIndex = 0;
    tr.dataset.team = team.name;
    tr.innerHTML = `
      <td>${esc(team.name)}</td>
      <td class="rating-cell">Div ${team.division}</td>
      <td class="rating-cell">${Math.round(r.goalkeeping)}</td>
      <td class="rating-cell">${Math.round(r.defense)}</td>
      <td class="rating-cell">${Math.round(r.midfield)}</td>
      <td class="rating-cell">${Math.round(r.attack)}</td>
      <td class="rating-overall">${overallRating(team)}</td>
      <td class="rating-cell">Top ${team.expectation}</td>`;
    tr.addEventListener('click', () => startCareer(team.name));
    tr.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); startCareer(team.name); }
    });
    tr.addEventListener('mouseenter', () => renderStartSquad(team));
    tr.addEventListener('focus', () => renderStartSquad(team));
    tbody.appendChild(tr);
  }
  const saved = loadGame();
  $('continue-save-btn').hidden = !saved;
  if (saved) {
    $('continue-save-btn').textContent =
      `Continue: ${saved.managerName} at ${saved.clubName} (S${saved.seasonIndex + 1} W${saved.week + 1})`;
  }
}

function renderStartSquad(team) {
  $('squad-title').textContent = `Squad — ${team.name}`;
  $('squad-rows').innerHTML = team.players
    .map((p) => `<tr><td class="pos">${p.pos}</td><td>${esc(p.name)}</td><td>${p.age}</td><td>${p.atk}</td><td>${p.def}</td></tr>`)
    .join('');
}

function startCareer(clubName) {
  const managerName = $('manager-name').value.trim() || 'The Boss';
  state.game = new Game({ managerName, clubName });
  state.lineup = null;
  enterHub('inbox');
  saveGame('Career started');
}

// --- Hub shell ----------------------------------------------------------------------

function enterHub(screen = state.screen) {
  $('start-screen').hidden = true;
  $('match-screen').hidden = true;
  $('hub-screen').hidden = false;
  setScreen(screen);
}

function updateHud() {
  const g = state.game;
  if (!g) { $('hud').textContent = 'SEASON 96/97 · v0.2'; return; }
  $('hud').textContent =
    `${g.clubName} (Div ${g.club.division}) · ${g.managerName} · Season ${g.seasonIndex + 1} · Week ${g.week + 1} · ${money(g.club.balance)}`;
}

function setScreen(screen) {
  state.screen = screen;
  state.swapSel = null;
  for (const btn of document.querySelectorAll('.nav-btn')) {
    btn.classList.toggle('active', btn.dataset.screen === screen);
  }
  renderHub();
}

function renderHub() {
  updateHud();
  const g = state.game;
  const offers = g.pendingOffers.length;
  $('inbox-badge').hidden = offers === 0;
  $('inbox-badge').textContent = offers;

  if (g.sacked) {
    const offers = g.jobOffers.map((name) => {
      const club = g.getClub(name);
      return `<div class="news-item">
        <span class="news-subject">${esc(name)}</span>
        <span class="dim"> · Division ${club.division} · squad rating ${overallRating(club)}</span>
        <div class="news-actions"><button class="mini-btn" data-job="${esc(name)}">Take the job</button></div>
      </div>`;
    }).join('');
    $('hub-content').innerHTML = `
      <h1>Sacked</h1>
      <div class="panel">
        <p>The ${esc(g.clubName)} board have terminated your contract.
        Reputation: ${g.reputation}/100 after ${g.history.length} full season${g.history.length === 1 ? '' : 's'}.</p>
      </div>
      ${offers
        ? `<div class="panel"><h2 class="panel-title">Clubs willing to talk</h2>${offers}</div>`
        : '<div class="panel"><p class="dim">No club will touch you. This career is over.</p></div>'}
      <div class="panel"><div class="news-actions">
        <button class="btn" id="new-career-btn">Retire and start a new career</button>
      </div></div>`;
    for (const btn of $('hub-content').querySelectorAll('[data-job]')) {
      btn.addEventListener('click', () => {
        g.acceptJob(btn.dataset.job);
        state.lineup = null;
        saveGame();
        renderHub();
      });
    }
    $('new-career-btn').addEventListener('click', () => {
      localStorage.removeItem(SAVE_KEY);
      location.reload();
    });
    return;
  }

  const renderers = {
    inbox: renderInbox, squad: renderSquad, tactics: renderTactics,
    fixtures: renderFixtures, table: renderTable, cup: renderCup,
    transfers: renderTransfers, finances: renderFinances, club: renderClub,
    week: renderWeekSummary,
  };
  (renderers[state.screen] ?? renderInbox)();
}

// --- Hub screens ---------------------------------------------------------------------

function renderInbox() {
  const g = state.game;
  const items = g.inbox.slice(0, 40).map((n, i) => {
    let actions = '';
    if (n.offerId && g.pendingOffers.some((o) => o.id === n.offerId)) {
      actions = `<div class="news-actions">
        <button class="mini-btn" data-offer="${n.offerId}" data-accept="1">Accept</button>
        <button class="mini-btn" data-offer="${n.offerId}" data-accept="0">Reject</button>
      </div>`;
    }
    return `<div class="news-item">
      <span class="news-week">S${n.season + 1} W${n.week + 1}</span>
      <span class="news-subject">${esc(n.subject)}</span>
      <div class="news-body">${esc(n.body)}</div>${actions}
    </div>`;
  }).join('');
  $('hub-content').innerHTML = `<h1>Inbox</h1>
    <div class="panel">${items || '<p class="dim">No news yet. Hit Continue.</p>'}</div>`;

  for (const btn of $('hub-content').querySelectorAll('[data-offer]')) {
    btn.addEventListener('click', () => {
      const res = state.game.respondToOffer(Number(btn.dataset.offer), btn.dataset.accept === '1');
      if (res.ok === false) state.game.news('Offer', res.reason ?? 'Could not complete.');
      saveGame();
      renderHub();
    });
  }
}

function renderSquad() {
  const g = state.game;
  const players = [...g.club.players].sort(
    (a, b) => ['GK', 'DF', 'MF', 'FW'].indexOf(a.pos) - ['GK', 'DF', 'MF', 'FW'].indexOf(b.pos) ||
      ability(b) - ability(a)
  );
  const rows = players.map((p) => `
    <tr>
      <td>${p.pos}</td>
      <td class="left">${esc(p.name)}${statusTags(p)}</td>
      <td>${p.age}</td>
      <td>${p.atk}</td>
      <td>${p.def}</td>
      <td>${bar(p.condition)}</td>
      <td>${p.form.toFixed(1)}</td>
      <td>${bar(p.morale)}</td>
      <td>${money(p.wage)}/w</td>
      <td>${money(p.value)}</td>
      <td class="${p.contractYears <= 1 ? 'bad' : ''}">${p.contractYears}y</td>
      <td>
        <button class="mini-btn" data-list="${p.id}">${p.listed ? 'Unlist' : 'List'}</button>
        <button class="mini-btn" data-renew="${p.id}">Renew</button>
      </td>
    </tr>`).join('');
  $('hub-content').innerHTML = `<h1>Squad</h1>
    <p class="hint">${g.club.players.length} players · wage bill ${money(g.club.players.reduce((s, p) => s + p.wage, 0))}/week</p>
    <div class="panel"><table class="data-table">
      <thead><tr><th>Pos</th><th class="left">Name</th><th>Age</th><th>Att</th><th>Def</th>
      <th>Cond</th><th>Form</th><th>Morale</th><th>Wage</th><th>Value</th><th>Deal</th><th></th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;

  for (const btn of $('hub-content').querySelectorAll('[data-list]')) {
    btn.addEventListener('click', () => { g.toggleTransferList(btn.dataset.list); saveGame(); renderHub(); });
  }
  for (const btn of $('hub-content').querySelectorAll('[data-renew]')) {
    btn.addEventListener('click', () => { g.renewContract(btn.dataset.renew); saveGame(); renderHub(); });
  }
}

// Current lineup, rebuilding the default when players became unavailable.
function currentLineup() {
  const g = state.game;
  if (state.lineup) {
    const everyone = [...state.lineup.starters.map((s) => s.player), ...state.lineup.bench];
    const stillMine = (p) => g.club.players.some((q) => q.id === p.id);
    if (everyone.every((p) => isAvailable(p) && stillMine(p)) &&
      state.lineup.formation === g.tactics.formation) {
      return state.lineup;
    }
  }
  state.lineup = g.defaultLineup();
  return state.lineup;
}

function renderTactics() {
  const g = state.game;
  const lineup = currentLineup();
  const reserves = g.club.players.filter(
    (p) => !lineup.starters.some((s) => s.player.id === p.id) &&
      !lineup.bench.some((b) => b.id === p.id)
  );

  const row = (list, idx, label, p, extra = '') => {
    const sel = state.swapSel && state.swapSel.list === list && state.swapSel.index === idx;
    const avail = isAvailable(p) ? '' : ' <span class="status-tag inj">OUT</span>';
    return `<tr class="clickable ${sel ? 'swap-selected' : ''}" data-swap="${list}:${idx}">
      <td>${label}</td><td class="left">${esc(p.name)}${avail}${extra}</td>
      <td>${p.pos}</td><td>${p.atk}</td><td>${p.def}</td>
      <td>${bar(p.condition)}</td><td>${p.form.toFixed(1)}</td></tr>`;
  };

  const starterRows = lineup.starters.map((s, i) =>
    row('starters', i, s.slot, s.player, s.slot !== s.player.pos ? ' <span class="status-tag ban">OOP</span>' : '')
  ).join('');
  const benchRows = lineup.bench.map((p, i) => row('bench', i, 'SUB', p)).join('');
  const reserveRows = reserves.map((p, i) => row('reserves', i, '—', p)).join('');

  const formationOpts = Object.keys(FORMATIONS)
    .map((f) => `<option ${f === g.tactics.formation ? 'selected' : ''}>${f}</option>`).join('');
  const mentalityOpts = MENTALITIES
    .map((m) => `<option ${m === g.tactics.mentality ? 'selected' : ''}>${m}</option>`).join('');

  $('hub-content').innerHTML = `<h1>Tactics</h1>
    <p class="hint">Click two players to swap them. OOP = out of position (plays weaker).</p>
    <div class="panel tactics-controls">
      <label>Formation <select id="formation-select">${formationOpts}</select></label>
      <label>Mentality <select id="mentality-select">${mentalityOpts}</select></label>
      <button class="btn" id="autopick-btn">Auto-pick best XI</button>
    </div>
    <div class="panel"><h2 class="panel-title">Starting XI</h2>
      <table class="data-table"><thead><tr><th>Slot</th><th class="left">Name</th><th>Pos</th><th>Att</th><th>Def</th><th>Cond</th><th>Form</th></tr></thead>
      <tbody>${starterRows}</tbody></table></div>
    <div class="panel"><h2 class="panel-title">Bench</h2>
      <table class="data-table"><tbody>${benchRows || '<tr><td class="dim">Empty</td></tr>'}</tbody></table></div>
    <div class="panel"><h2 class="panel-title">Reserves</h2>
      <table class="data-table"><tbody>${reserveRows || '<tr><td class="dim">None</td></tr>'}</tbody></table></div>`;

  $('formation-select').addEventListener('change', (e) => {
    g.setTactics({ formation: e.target.value });
    state.lineup = null;
    saveGame();
    renderHub();
  });
  $('mentality-select').addEventListener('change', (e) => {
    g.setTactics({ mentality: e.target.value });
    saveGame();
  });
  $('autopick-btn').addEventListener('click', () => {
    state.lineup = null;
    renderHub();
  });

  const lists = { starters: lineup.starters, bench: lineup.bench, reserves };
  for (const tr of $('hub-content').querySelectorAll('[data-swap]')) {
    tr.addEventListener('click', () => {
      const [list, idxStr] = tr.dataset.swap.split(':');
      const index = Number(idxStr);
      if (!state.swapSel) {
        state.swapSel = { list, index };
        renderHub();
        return;
      }
      const a = state.swapSel;
      state.swapSel = null;
      if (a.list === list && a.index === index) { renderHub(); return; }
      swapPlayers(lists, a, { list, index });
      renderHub();
    });
  }
}

function swapPlayers(lists, a, b) {
  const get = (sel) => {
    const entry = lists[sel.list][sel.index];
    return sel.list === 'starters' ? entry.player : entry;
  };
  const set = (sel, player) => {
    if (sel.list === 'starters') lists[sel.list][sel.index].player = player;
    else lists[sel.list][sel.index] = player;
  };
  const pa = get(a);
  const pb = get(b);
  set(a, pb);
  set(b, pa);
  // Reserves are derived, so only starters/bench persist on the lineup.
  state.lineup = {
    starters: lists.starters,
    bench: lists.bench.slice(0, 5),
    formation: state.game.tactics.formation,
  };
}

function renderFixtures() {
  const g = state.game;
  const rows = g.calendar.map((event, week) => {
    let label;
    let opponentInfo = '';
    if (event.type === 'league') {
      label = `League Round ${event.round + 1}`;
      const pairing = g.fixtures[g.club.division][event.round].find(
        (p) => p.home === g.clubName || p.away === g.clubName
      );
      if (pairing) {
        const isHome = pairing.home === g.clubName;
        const opp = isHome ? pairing.away : pairing.home;
        const played = week < g.week
          ? g.results.find((r) => r.home === pairing.home && r.away === pairing.away)
          : null;
        opponentInfo = played
          ? `${esc(pairing.home)} <b>${played.homeGoals} - ${played.awayGoals}</b> ${esc(pairing.away)}`
          : `${esc(opp)} (${isHome ? 'H' : 'A'})`;
      }
    } else {
      const roundName = g.cupRoundLabel(event.cupRound);
      label = `Cup ${roundName}`;
      const played = g.cupResults.find(
        (r) => r.round === roundName &&
          (r.home === g.clubName || r.away === g.clubName)
      );
      if (played) {
        opponentInfo = `${esc(played.home)} <b>${played.homeGoals} - ${played.awayGoals}</b> ${esc(played.away)}` +
          (played.shootout ? ` <span class="dim">(${played.shootout.home}-${played.shootout.away} pens)</span>` : '');
      } else if (week >= g.week) {
        const tie = g.cup.ties.find((t) => t.home === g.clubName || t.away === g.clubName);
        opponentInfo = week === g.week && tie
          ? `${esc(tie.home === g.clubName ? tie.away : tie.home)} (${tie.home === g.clubName ? 'H' : 'A'})`
          : inCup(g.cup, g.clubName) ? 'TBD' : '<span class="dim">eliminated</span>';
      }
    }
    return `<tr class="${week === g.week ? 'highlight' : ''}">
      <td>W${week + 1}</td><td class="left">${label}</td><td class="left">${opponentInfo || '<span class="dim">—</span>'}</td></tr>`;
  }).join('');
  $('hub-content').innerHTML = `<h1>Fixtures &amp; Results</h1>
    <div class="panel"><table class="data-table">
    <thead><tr><th>Week</th><th class="left">Competition</th><th class="left">Your match</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

function renderTable() {
  const g = state.game;
  const divisionPanel = (division) => {
    const table = g.divisionTable(division);
    const rows = table.map((r, i) => {
      const zone = division === 1 && i >= table.length - 2 ? 'zone-down'
        : division === 2 && i < 2 ? 'zone-up' : '';
      return `
      <tr class="${r.team === g.clubName ? 'highlight' : ''} ${zone}">
        <td>${i + 1}</td><td class="left">${esc(r.team)}</td>
        <td>${r.played}</td><td>${r.won}</td><td>${r.drawn}</td><td>${r.lost}</td>
        <td>${r.goalsFor}</td><td>${r.goalsAgainst}</td>
        <td class="${r.goalDiff > 0 ? 'good' : r.goalDiff < 0 ? 'bad' : ''}">${r.goalDiff > 0 ? '+' : ''}${r.goalDiff}</td>
        <td class="gold">${r.points}</td></tr>`;
    }).join('');
    return `<div class="panel"><h2 class="panel-title">Division ${division}
        ${division === 1 ? '<span class="dim"> · bottom two relegated</span>' : '<span class="dim"> · top two promoted</span>'}</h2>
      <table class="data-table">
      <thead><tr><th>#</th><th class="left">Club</th><th>P</th><th>W</th><th>D</th><th>L</th><th>GF</th><th>GA</th><th>GD</th><th>Pts</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
  };
  const mine = g.club.division;
  const other = mine === 1 ? 2 : 1;
  $('hub-content').innerHTML = `<h1>League Tables</h1>
    ${divisionPanel(mine)}${divisionPanel(other)}`;
}

function renderCup() {
  const g = state.game;
  const byRound = {};
  for (const r of g.cupResults) (byRound[r.round] ??= []).push(r);
  const sections = Object.entries(byRound).map(([round, results]) => `
    <div class="panel"><h2 class="panel-title">${esc(round)}</h2>
      ${results.map((r) => `<div class="news-body">
        ${esc(r.home)} <b>${r.homeGoals} - ${r.awayGoals}</b> ${esc(r.away)}
        ${r.shootout ? `<span class="dim">(${r.shootout.home}-${r.shootout.away} pens)</span>` : ''}
        <span class="dim">→ ${esc(r.winner)}</span></div>`).join('')}
    </div>`).join('');

  let current = '';
  if (g.cup.winner) {
    current = `<div class="panel"><h2 class="panel-title">Winner</h2>
      <div class="news-body gold">🏆 ${esc(g.cup.winner)}</div></div>`;
  } else if (g.cup.ties.length > 0) {
    current = `<div class="panel"><h2 class="panel-title">Next: ${esc(cupRoundName(g.cup))}</h2>
      ${g.cup.ties.map((t) => `<div class="news-body">${esc(t.home)} v ${esc(t.away)}</div>`).join('')}
      ${g.cup.byes.length ? `<div class="news-body dim">Byes: ${g.cup.byes.map(esc).join(', ')}</div>` : ''}
    </div>`;
  }
  $('hub-content').innerHTML = `<h1>The Cup</h1>${current}${sections || ''}`;
}

function renderTransfers() {
  const g = state.game;
  const { pos, maxValue } = state.transferFilters;
  const results = g.searchPlayers({
    pos: pos || null,
    maxValue: maxValue ? Number(maxValue) * 1000000 : null,
  }).slice(0, 40);

  const attrCell = (p, attr) => {
    const d = g.attrDisplay(p, attr);
    return d.exact !== undefined
      ? `<td class="good">${d.exact}</td>`
      : `<td class="dim">${d.lo}–${d.hi}</td>`;
  };
  const scoutCell = (p) => {
    if (g.knowsExactly(p)) return '<span class="dim">✓</span>';
    if (g.pendingScouts.some((s) => s.playerId === p.id)) return '<span class="dim">scouting…</span>';
    return `<button class="mini-btn" data-scout="${p.id}">Scout</button>`;
  };
  const rows = results.map((r) => `
    <tr>
      <td>${r.player.pos}</td>
      <td class="left">${esc(r.player.name)}${statusTags(r.player)}</td>
      <td class="left">${r.club ? esc(r.club) : '<span class="good">Free agent</span>'}</td>
      <td>${r.player.age}</td>${attrCell(r.player, 'atk')}${attrCell(r.player, 'def')}
      <td>${money(r.player.value)}</td>
      <td class="gold">${r.club ? money(r.asking) : '—'}</td>
      <td>${scoutCell(r.player)}
        <button class="mini-btn" data-bid="${r.player.id}" data-asking="${r.asking}">
        ${r.club ? 'Bid' : 'Sign'}</button></td>
    </tr>`).join('');

  const posOpts = ['', 'GK', 'DF', 'MF', 'FW']
    .map((p) => `<option value="${p}" ${p === pos ? 'selected' : ''}>${p || 'Any position'}</option>`).join('');

  $('hub-content').innerHTML = `<h1>Transfer Market</h1>
    <p class="hint">Transfer budget: <b class="gold">${money(g.club.transferBudget)}</b> · Balance: ${money(g.club.balance)}
    · Scout reports £15k, filed in a week — until then you see estimates.</p>
    <div class="panel tactics-controls">
      <label>Position <select id="filter-pos">${posOpts}</select></label>
      <label>Max value (£M) <input id="filter-value" type="number" min="0" step="0.5" value="${esc(maxValue)}" style="width:80px"></label>
      ${state.transferNote ? `<span class="gold">${esc(state.transferNote)}</span>` : ''}
    </div>
    <div class="panel"><table class="data-table">
      <thead><tr><th>Pos</th><th class="left">Name</th><th class="left">Club</th><th>Age</th>
      <th>Att</th><th>Def</th><th>Value</th><th>Asking</th><th></th></tr></thead>
      <tbody>${rows || '<tr><td colspan="9" class="dim">No players match.</td></tr>'}</tbody></table></div>`;

  $('filter-pos').addEventListener('change', (e) => {
    state.transferFilters.pos = e.target.value;
    renderHub();
  });
  $('filter-value').addEventListener('change', (e) => {
    state.transferFilters.maxValue = e.target.value;
    renderHub();
  });
  for (const btn of $('hub-content').querySelectorAll('[data-scout]')) {
    btn.addEventListener('click', () => {
      const res = g.scoutPlayer(btn.dataset.scout);
      state.transferNote = res.ok
        ? 'Scout dispatched — report due next week.'
        : `No scout sent: ${res.reason}.`;
      saveGame();
      renderHub();
    });
  }
  for (const btn of $('hub-content').querySelectorAll('[data-bid]')) {
    btn.addEventListener('click', () => {
      const asking = Number(btn.dataset.asking);
      const res = g.bid(btn.dataset.bid, asking);
      state.transferNote =
        res.status === 'accepted' ? (res.free ? 'Signed on a free!' : `Signed for ${money(asking)}.`) :
        res.status === 'countered' ? `Countered at ${money(res.counter)} — bid again to accept.` :
        `Rejected: ${res.reason}.`;
      if (res.status === 'countered') btn.dataset.asking = res.counter;
      state.lineup = null;
      saveGame();
      renderHub();
    });
  }
}

function renderFinances() {
  const g = state.game;
  const wageBill = g.club.players.reduce((s, p) => s + p.wage, 0);
  const topEarners = [...g.club.players].sort((a, b) => b.wage - a.wage).slice(0, 8);
  $('hub-content').innerHTML = `<h1>Finances</h1>
    <div class="panel"><table class="data-table"><tbody>
      <tr><td class="left">Balance</td><td class="gold">${money(g.club.balance)}</td></tr>
      <tr><td class="left">Transfer budget</td><td>${money(g.club.transferBudget)}</td></tr>
      <tr><td class="left">Weekly wage bill</td><td class="${wageBill * 30 > g.club.balance ? 'bad' : ''}">${money(wageBill)}/week</td></tr>
    </tbody></table></div>
    <div class="panel"><h2 class="panel-title">Gate receipts</h2>
      <table class="data-table"><tbody>
      <tr><td class="left">Fanbase</td><td>${g.club.fanbase.toLocaleString()} supporters</td></tr>
      <tr><td class="left">Stadium capacity</td><td>${g.club.capacity.toLocaleString()}</td></tr>
      <tr><td class="left">Last home attendance</td><td>${g.club.lastAttendance ? g.club.lastAttendance.toLocaleString() : '—'}</td></tr>
      <tr><td class="left">Average attendance (season)</td><td>${g.club.attendanceN ? Math.round(g.club.attendanceSum / g.club.attendanceN).toLocaleString() : '—'}</td></tr>
      <tr><td class="left">Last gate receipts</td><td class="gold">${g.club.lastAttendance ? money(g.club.lastAttendance * 14) : '—'}</td></tr>
      <tr><td class="left dim" colspan="2">Win matches to grow the fanbase — bigger crowds, bigger gates.</td></tr>
    </tbody></table></div>
    ${renderExpansionPanel(g)}
    <div class="panel"><h2 class="panel-title">Top earners</h2>
      <table class="data-table"><tbody>
      ${topEarners.map((p) => `<tr><td class="left">${esc(p.name)}</td><td>${money(p.wage)}/w</td><td>${p.contractYears}y left</td></tr>`).join('')}
      </tbody></table></div>`;

  $('expand-btn')?.addEventListener('click', () => {
    const res = state.game.requestExpansion();
    if (!res.ok) state.game.news('Expansion refused', res.reason);
    saveGame();
    renderHub();
  });
}

function renderExpansionPanel(g) {
  const quote = g.expansionQuote();
  let body;
  if (quote.active) {
    body = `<div class="news-body">🏗️ Builders in: ${quote.active.seats.toLocaleString()} new seats,
      ready in ${quote.active.weeksLeft} week${quote.active.weeksLeft === 1 ? '' : 's'}.</div>`;
  } else {
    const blocked = !quote.demandOk ? 'Board wants a fuller ground first'
      : !quote.canAfford ? 'Not enough money' : '';
    body = `<div class="news-actions">
      <button class="mini-btn" id="expand-btn" ${blocked ? 'disabled' : ''}>
        Add ${quote.seats.toLocaleString()} seats — ${money(quote.cost)}</button>
      ${blocked ? `<span class="dim">${blocked}</span>` : ''}
    </div>`;
  }
  return `<div class="panel"><h2 class="panel-title">Stadium expansion</h2>${body}</div>`;
}

function renderClub() {
  const g = state.game;
  const pos = g.leaguePosition();
  const conf = g.board.confidence;
  const scorers = Object.entries(g.seasonStats)
    .map(([id, s]) => ({ id, ...s, found: g.findPlayer(id) }))
    .filter((s) => s.found && s.goals > 0)
    .sort((a, b) => b.goals - a.goals)
    .slice(0, 10);

  const jobOfferPanel = g.pendingJobOffer
    ? `<div class="panel"><h2 class="panel-title">An offer from above</h2>
        <div class="news-body">${esc(g.pendingJobOffer.club)} want you as their manager.</div>
        <div class="news-actions">
          <button class="mini-btn" id="job-accept">Accept</button>
          <button class="mini-btn" id="job-decline">Stay loyal</button>
        </div></div>`
    : '';
  $('hub-content').innerHTML = `<h1>Club &amp; Board</h1>
    ${jobOfferPanel}
    <div class="panel"><table class="data-table"><tbody>
      <tr><td class="left">Board confidence</td><td>${bar(conf, 30, 55)} ${conf}/100</td></tr>
      <tr><td class="left">Manager reputation</td><td>${bar(g.reputation, 30, 55)} ${g.reputation}/100</td></tr>
      <tr><td class="left">Board expectation</td><td>Finish ${g.ordinal(g.club.expectation)} or better in Division ${g.club.division}</td></tr>
      <tr><td class="left">Current position</td><td class="${pos <= g.club.expectation ? 'good' : 'bad'}">${g.ordinal(pos)} in Division ${g.club.division}</td></tr>
    </tbody></table></div>
    <div class="panel"><h2 class="panel-title">League top scorers</h2>
      <table class="data-table"><tbody>
      ${scorers.map((s) => `<tr><td class="left">${esc(s.found.player.name)}</td>
        <td class="left dim">${esc(s.found.club?.name ?? '—')}</td>
        <td>${s.goals} goals</td><td>${s.apps} apps</td>
        <td>${(s.ratingSum / Math.max(1, s.ratingN)).toFixed(1)} avg</td></tr>`).join('') ||
        '<tr><td class="dim">No goals yet.</td></tr>'}
      </tbody></table></div>
    ${g.history.length ? `<div class="panel"><h2 class="panel-title">Past seasons</h2>
      <table class="data-table">
      <thead><tr><th>Season</th><th class="left">Champions</th><th class="left">Cup</th><th>You</th><th class="left">Top scorer</th></tr></thead>
      <tbody>${g.history.map((h) => `<tr><td>${h.season + 1}</td>
        <td class="left">${esc(h.champion)}</td><td class="left">${esc(h.cupWinner ?? '—')}</td>
        <td>${g.ordinal(h.userPosition)}${h.userDivision ? ` (D${h.userDivision})` : ''}</td>
        <td class="left">${h.topScorer ? `${esc(h.topScorer.name)} (${h.topScorer.goals})` : '—'}</td></tr>`).join('')}
      </tbody></table></div>` : ''}`;

  $('job-accept')?.addEventListener('click', () => {
    state.game.respondToJobOffer(true);
    state.lineup = null;
    saveGame();
    renderHub();
  });
  $('job-decline')?.addEventListener('click', () => {
    state.game.respondToJobOffer(false);
    saveGame();
    renderHub();
  });
}

function renderWeekSummary() {
  const g = state.game;
  const results = g.lastResults ?? [];
  const line = (r) => {
    const mine = r.home === g.clubName || r.away === g.clubName;
    return `<div class="news-body ${mine ? 'gold' : ''}">
      ${esc(r.home)} <b>${r.homeGoals} - ${r.awayGoals}</b> ${esc(r.away)}
      ${r.shootout ? `<span class="dim">(${r.shootout.home}-${r.shootout.away} pens)</span>` : ''}</div>`;
  };
  const groups = [];
  const cup = results.filter((r) => r.competition === 'cup');
  if (cup.length > 0) {
    groups.push(`<div class="panel"><h2 class="panel-title">The Cup</h2>${cup.map(line).join('')}</div>`);
  }
  const mine = g.club.division;
  for (const d of [mine, mine === 1 ? 2 : 1]) {
    const divResults = results.filter((r) => r.division === d);
    if (divResults.length > 0) {
      groups.push(`<div class="panel"><h2 class="panel-title">Division ${d}</h2>${divResults.map(line).join('')}</div>`);
    }
  }
  $('hub-content').innerHTML = `<h1>Week ${g.week} results</h1>
    ${groups.join('') || '<div class="panel"><p class="dim">No matches this week.</p></div>'}
    <div class="panel"><h2 class="panel-title">Division ${mine} top six</h2>
      <table class="data-table"><tbody>
      ${g.table.slice(0, 6).map((r, i) => `<tr class="${r.team === g.clubName ? 'highlight' : ''}">
        <td>${i + 1}</td><td class="left">${esc(r.team)}</td><td>${r.played}</td><td class="gold">${r.points}</td></tr>`).join('')}
      </tbody></table></div>`;
}

// --- Continue flow -------------------------------------------------------------------

function onContinue() {
  const g = state.game;
  if (g.sacked) return;
  const fixture = g.userFixture();
  if (fixture) {
    showPreMatch(fixture);
  } else {
    g.advanceWeek(null);
    saveGame('Auto-saved');
    setScreen(g.sacked ? 'inbox' : 'week');
  }
}

// --- Match day ------------------------------------------------------------------------

function showPreMatch(fixture) {
  const g = state.game;
  const lineup = currentLineup();
  $('hub-screen').hidden = true;
  $('match-screen').hidden = false;
  $('prematch').hidden = false;
  $('matchday').hidden = true;

  const opp = fixture.isHome ? fixture.away : fixture.home;
  $('prematch-title').textContent = `${fixture.home} v ${fixture.away}`;
  $('prematch-sub').textContent =
    `${fixture.type === 'cup' ? `Cup ${fixture.round}` : `League Round ${fixture.round}`} · ` +
    `${fixture.isHome ? 'Home' : 'Away'} to ${opp} · ${g.tactics.formation}, ${g.tactics.mentality}`;
  $('prematch-xi').innerHTML = lineup.starters.map((s) =>
    `<tr><td class="pos">${s.slot}</td><td>${esc(s.player.name)}</td>
     <td>${s.player.atk}</td><td>${s.player.def}</td></tr>`).join('');
  $('prematch-bench').innerHTML = lineup.bench.map((p) =>
    `<tr><td class="pos">${p.pos}</td><td>${esc(p.name)}</td><td>${p.atk}</td><td>${p.def}</td></tr>`).join('') ||
    '<tr><td class="empty">Empty bench</td></tr>';

  // Scout the opposition.
  const report = g.oppositionReport(opp);
  const formStr = report.form.length
    ? report.form.map((f) =>
        `<span class="${f === 'W' ? 'good' : f === 'L' ? 'bad' : 'dim'}">${f}</span>`).join(' ')
    : '<span class="dim">no matches yet</span>';
  $('opp-summary').innerHTML =
    `${g.ordinal(report.position)} in Division ${report.division} · Form: ${formStr}<br>` +
    `Danger man: <b class="gold">${esc(report.dangerMan.name)}</b> (${report.dangerMan.pos})`;
  $('opp-xi').innerHTML = report.xi.map((s) =>
    `<tr class="${s.player.id === report.dangerMan.id ? 'highlight' : ''}">
      <td class="pos">${s.slot}</td><td>${esc(s.player.name)}</td>
      <td>${s.player.form.toFixed(1)}</td></tr>`).join('');
}

function kickOff() {
  const g = state.game;
  const { sim, fixture, userSide, attendance } = g.startUserMatch(currentLineup());
  state.match = {
    sim, fixture, userSide,
    timer: null, speed: 250, paused: false,
    statsTab: 'home', prevGoals: new Map(), subSel: { off: null, on: null },
  };
  $('prematch').hidden = true;
  $('matchday').hidden = false;
  $('fulltime').hidden = true;
  $('sub-panel').hidden = true;
  $('pause-btn').textContent = 'Pause';
  $('pause-reason').textContent = '';
  $('score-home').textContent = sim.sides.home.setup.name;
  $('score-away').textContent = sim.sides.away.setup.name;
  $('score-att').textContent = `Att ${attendance.toLocaleString()}`;
  $('tab-home').textContent = sim.sides.home.setup.shortName;
  $('tab-away').textContent = sim.sides.away.setup.shortName;
  $('commentary').innerHTML = '';
  $('pitch-home-label').textContent = sim.sides.home.setup.name;
  $('pitch-away-label').textContent = sim.sides.away.setup.name;
  updateScoreboard();
  renderPitch();
  renderMatchPlayerTable();
  scheduleTick();
}

function stopTimer() {
  clearTimeout(state.match?.timer);
  if (state.match) state.match.timer = null;
}

function scheduleTick() {
  const m = state.match;
  stopTimer();
  if (!m || m.paused || m.sim.finished) return;
  if (m.speed === 0) {
    while (!m.sim.finished) doTick();
    return;
  }
  m.timer = setTimeout(() => { doTick(); scheduleTick(); }, m.speed);
}

// Moments the manager should react to. Returns a banner string or null.
function keyMoment(events, userSide) {
  for (const e of events) {
    if (e.type === 'half-time') return 'Half time';
    if (e.type === 'extra-time') return 'Extra time';
    if (e.type === 'red') return `Red card — ${e.player}`;
    if (e.type === 'injury' && e.side === userSide) {
      return `${e.player} is injured — make a substitution`;
    }
  }
  return null;
}

function doTick() {
  const m = state.match;
  const events = m.sim.playMinute();
  updateScoreboard();
  for (const e of events) appendCommentary(e);
  if (m.speed !== 0 || m.sim.finished) {
    renderPitch();
    renderMatchPlayerTable();
  }
  if (m.sim.finished) {
    stopTimer();
    showFullTime();
    return;
  }
  // Key moments pause the match for a decision — unless the manager has
  // asked for an instant result.
  const moment = m.speed !== 0 ? keyMoment(events, m.userSide) : null;
  if (moment) pauseMatch(moment);
}

function pauseMatch(reason) {
  const m = state.match;
  if (!m || m.paused || m.sim.finished) return;
  m.paused = true;
  stopTimer();
  $('pause-btn').textContent = 'Resume';
  $('pause-reason').textContent = reason;
  $('sub-panel').hidden = false;
  renderSubPanel();
  renderPitch();
  renderMatchPlayerTable();
}

function updateScoreboard() {
  const m = state.match;
  const minute = m.sim.minute;
  $('score-nums').textContent = `${m.sim.score.home} - ${m.sim.score.away}`;
  const base = Math.min(minute, m.sim.inExtraTime ? 120 : 90);
  const over = minute > 90 && !m.sim.inExtraTime ? `+${minute - 90}` : '';
  $('score-clock').textContent = `${base}'${over}${m.sim.inExtraTime ? ' aet' : ''}`;
}

const EVENT_CLASSES = {
  goal: 'ev-goal', red: 'ev-red', yellow: 'ev-yellow', injury: 'ev-red',
  sub: 'ev-whistle', tactics: 'ev-whistle', kickoff: 'ev-whistle', 'half-time': 'ev-whistle',
  'full-time': 'ev-whistle', 'extra-time': 'ev-whistle', penalties: 'ev-whistle',
  'penalty-scored': 'ev-goal', 'penalty-missed': 'ev-yellow', 'shootout-end': 'ev-goal',
};

function appendCommentary(e) {
  const list = $('commentary');
  const li = document.createElement('li');
  const cls = EVENT_CLASSES[e.type];
  li.innerHTML = `<span class="min">${e.minute}'</span><span${cls ? ` class="${cls}"` : ''}>${esc(e.text)}</span>`;
  list.appendChild(li);
  list.scrollTop = list.scrollHeight;
  if (e.type === 'goal') flashScoreboard();
}

function flashScoreboard() {
  const board = $('scoreboard');
  board.classList.remove('goal-flash');
  void board.offsetWidth;
  board.classList.add('goal-flash');
}

function ratingBand(rating) {
  if (rating < 5.5) return 'poor';
  if (rating < 6.5) return 'ok';
  if (rating < 7.5) return 'good';
  return 'star';
}

const ROW_Y = {
  away: { GK: 5, DF: 16.5, MF: 29, FW: 41 },
  home: { GK: 95, DF: 83.5, MF: 71, FW: 59 },
};

function renderPitch() {
  const m = state.match;
  const container = $('pitch-players');
  container.innerHTML = '';
  for (const sideKey of ['home', 'away']) {
    const side = m.sim.sides[sideKey];
    const units = { GK: [], DF: [], MF: [], FW: [] };
    for (const entry of side.onPitch) units[entry.slot].push(entry);
    for (const [unit, entries] of Object.entries(units)) {
      entries.forEach((entry, i) => {
        const line = side.lines.get(entry.player.id ?? entry.player.name);
        const x = (100 / (entries.length + 1)) * (i + 1);
        const chip = document.createElement('div');
        chip.className = `chip ${sideKey}`;
        chip.style.left = `${x}%`;
        chip.style.top = `${ROW_Y[sideKey][unit]}%`;
        const marks = [];
        if (line.goals > 0) marks.push(`<span class="mark-goal">${'⚽'.repeat(Math.min(line.goals, 3))}</span>`);
        if (line.yellow > 0) marks.push('<span class="mark-yellow"></span>');
        chip.innerHTML = `
          <span class="chip-marks">${marks.join('')}</span>
          <span class="chip-rating r-${ratingBand(line.rating)}">${line.rating.toFixed(1)}</span>
          <span class="chip-name" title="${esc(entry.player.name)}">${esc(surname(entry.player.name))}</span>`;
        const prev = m.prevGoals.get(line.id) ?? 0;
        if (line.goals > prev) {
          m.prevGoals.set(line.id, line.goals);
          chip.classList.add('scored');
        }
        container.appendChild(chip);
      });
    }
  }
}

function renderMatchPlayerTable() {
  const m = state.match;
  const side = m.sim.sides[m.statsTab];
  const lines = [...side.lines.values()].filter((l) => l.minutes > 0 || l.started);
  $('player-rows').innerHTML = lines.map((l) => {
    const cell = (v) => `<td class="${v === 0 ? 'zero' : ''}">${v}</td>`;
    return `<tr class="${l.red > 0 ? 'dismissed' : ''}">
      <td>${l.slot}</td>
      <td title="${esc(l.name)}">${esc(surname(l.name))}${l.started ? '' : ' <span class="dim">(s)</span>'}</td>
      ${cell(l.passes)}${cell(l.tackles)}${cell(l.shots)}${cell(l.goals)}
      ${cell(l.assists)}${cell(l.saves)}${cell(l.fouls)}
      <td class="rat-${ratingBand(l.rating)}">${l.rating.toFixed(1)}</td>
    </tr>`;
  }).join('');
}

// --- Pause & substitutions ----------------------------------------------------------

function togglePause() {
  const m = state.match;
  if (!m || m.sim.finished) return;
  if (!m.paused) {
    pauseMatch('Paused');
    return;
  }
  m.paused = false;
  $('pause-btn').textContent = 'Pause';
  $('pause-reason').textContent = '';
  $('sub-panel').hidden = true;
  scheduleTick();
}

function renderSubPanel() {
  const m = state.match;
  const side = m.sim.sides[m.userSide];

  // Mid-match tactics for the user's side.
  $('match-formation').innerHTML = Object.keys(FORMATIONS)
    .map((f) => `<option ${f === side.setup.formation ? 'selected' : ''}>${f}</option>`).join('');
  $('match-mentality').innerHTML = MENTALITIES
    .map((mt) => `<option ${mt === side.setup.mentality ? 'selected' : ''}>${mt}</option>`).join('');

  $('subs-left').textContent = `(${3 - side.subsUsed} left)`;
  const offList = $('sub-off-list');
  const onList = $('sub-on-list');
  offList.innerHTML = side.onPitch.map((e) => {
    const line = side.lines.get(e.player.id ?? e.player.name);
    const id = e.player.id ?? e.player.name;
    return `<li data-off="${esc(id)}" class="${m.subSel.off === id ? 'selected' : ''}">
      ${e.slot} ${esc(e.player.name)} · ${line.rating.toFixed(1)} · ${Math.round(line.condition)}%</li>`;
  }).join('');
  onList.innerHTML = side.benchLeft.map((p) => {
    const id = p.id ?? p.name;
    return `<li data-on="${esc(id)}" class="${m.subSel.on === id ? 'selected' : ''}">
      ${p.pos} ${esc(p.name)}</li>`;
  }).join('') || '<li class="spent">No substitutes left</li>';

  for (const li of offList.querySelectorAll('[data-off]')) {
    li.addEventListener('click', () => { m.subSel.off = li.dataset.off; renderSubPanel(); });
  }
  for (const li of onList.querySelectorAll('[data-on]')) {
    li.addEventListener('click', () => { m.subSel.on = li.dataset.on; renderSubPanel(); });
  }
  $('make-sub-btn').disabled = !(m.subSel.off && m.subSel.on && side.subsUsed < 3);
}

function makeUserSub() {
  const m = state.match;
  const res = m.sim.makeSub(m.userSide, m.subSel.off, m.subSel.on);
  if (res.ok) {
    m.subSel = { off: null, on: null };
    const last = m.sim.events[m.sim.events.length - 1];
    appendCommentary(last);
    renderPitch();
    renderMatchPlayerTable();
  }
  renderSubPanel();
}

// --- Full time ---------------------------------------------------------------------------

function showFullTime() {
  const m = state.match;
  const result = m.sim.finish();
  updateScoreboard();
  renderPitch();
  renderMatchPlayerTable();

  $('scorers').innerHTML = ['home', 'away'].map((sideKey) => {
    const names = result.scorers[sideKey].map((s) => `${esc(s.player)} ${s.minute}'`).join(', ');
    const teamName = sideKey === 'home' ? result.homeTeam : result.awayTeam;
    return `<div><span class="side-name">${esc(teamName)}:</span> ${names || 'no scorers'}</div>`;
  }).join('') + (result.shootout
    ? `<div class="gold">Penalties: ${result.shootout.home} - ${result.shootout.away}</div>` : '');

  const all = [
    ...result.playerStats.home.filter((l) => l.minutes > 0).map((l) => ({ ...l, team: result.homeTeam })),
    ...result.playerStats.away.filter((l) => l.minutes > 0).map((l) => ({ ...l, team: result.awayTeam })),
  ];
  const motm = all.reduce((best, l) => (l.rating > best.rating ? l : best));
  $('motm').innerHTML =
    `<span class="motm-label">Man of the match:</span> ${esc(motm.name)} (${esc(motm.team)}) — ${motm.rating.toFixed(1)}`;

  const rows = [
    ['Possession %', 'possession'], ['Shots', 'shots'], ['On target', 'onTarget'],
    ['Corners', 'corners'], ['Fouls', 'fouls'], ['Yellow cards', 'yellowCards'], ['Red cards', 'redCards'],
  ];
  $('stats-rows').innerHTML = rows.map(([label, key]) => {
    const h = result.stats.home[key];
    const a = result.stats.away[key];
    const badKey = ['fouls', 'yellowCards', 'redCards'].includes(key);
    const hLead = badKey ? h < a : h > a;
    const aLead = badKey ? a < h : a > h;
    return `<tr><td class="${hLead ? 'leading' : ''}">${h}</td><td>${label}</td>
      <td class="${aLead ? 'leading' : ''}">${a}</td></tr>`;
  }).join('');

  $('sub-panel').hidden = true;
  $('pause-reason').textContent = '';
  $('fulltime').hidden = false;
  $('post-continue-btn').focus();
}

function afterMatchContinue() {
  const m = state.match;
  const result = m.sim.finish();
  stopTimer();
  state.match = null;
  state.lineup = null; // conditions changed; re-pick next week
  state.game.advanceWeek(result);
  saveGame('Auto-saved');
  $('match-screen').hidden = true;
  enterHub(state.game.sacked ? 'inbox' : 'week');
}

// --- Wiring -----------------------------------------------------------------------------

$('continue-save-btn').addEventListener('click', () => {
  const saved = loadGame();
  if (saved) {
    state.game = saved;
    enterHub('inbox');
  }
});

$('continue-btn').addEventListener('click', onContinue);
$('save-btn').addEventListener('click', () => saveGame());
$('play-match-btn').addEventListener('click', kickOff);
$('post-continue-btn').addEventListener('click', afterMatchContinue);
$('pause-btn').addEventListener('click', togglePause);
$('make-sub-btn').addEventListener('click', makeUserSub);

function applyMatchTactics() {
  const m = state.match;
  if (!m || m.sim.finished) return;
  const res = m.sim.setTactics(m.userSide, {
    formation: $('match-formation').value,
    mentality: $('match-mentality').value,
  });
  if (res.changed) {
    appendCommentary(m.sim.events[m.sim.events.length - 1]);
    renderPitch();
    renderMatchPlayerTable();
  }
}
$('match-formation').addEventListener('change', applyMatchTactics);
$('match-mentality').addEventListener('change', applyMatchTactics);

for (const btn of document.querySelectorAll('.nav-btn')) {
  btn.addEventListener('click', () => setScreen(btn.dataset.screen));
}

for (const btn of document.querySelectorAll('.speed-btn')) {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.speed-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    if (!state.match) return;
    state.match.speed = Number(btn.dataset.speed);
    if (!state.match.paused) scheduleTick();
  });
}

$('tab-home').addEventListener('click', () => {
  state.match.statsTab = 'home';
  $('tab-home').classList.add('active');
  $('tab-away').classList.remove('active');
  renderMatchPlayerTable();
});
$('tab-away').addEventListener('click', () => {
  state.match.statsTab = 'away';
  $('tab-away').classList.add('active');
  $('tab-home').classList.remove('active');
  renderMatchPlayerTable();
});

renderStartScreen();
