// Shared frame for dwmt product-view sketches: data model, i18n, header, drawer, sketch chrome.
(function () {
  const D = window.DWMT, PL = window.DWMT_PL || {};
  const App = (window.App = { D });
  let LANG = D.language === 'pl' ? 'pl' : 'en';
  let opts = null;

  // ---------- i18n ----------
  const T = {
    pl: {
      subtitle: 'Roadmapa produktu', generated: 'Wygenerowano', localFile: 'plik lokalny, dwmt',
      roadmap: 'Roadmapa', backlog: 'Backlog', decisions: 'Decyzje', history: 'Historia', productGoal: 'Cel produktu:',
      st_topic: 'Temat', st_notes: 'Notatki', st_ready: 'Gotowy', st_ordered: 'Zlecony', st_running: 'W toku',
      st_done: 'Czeka na przegląd', st_uat: 'Czeka na przegląd', st_closed: 'Zamknięty', st_dropped: 'Porzucony',
      k_bugfix: 'Poprawka', k_feature: 'Funkcja', k_maintenance: 'Utrzymanie',
      t_bug: 'Błąd', t_feature: 'Funkcja', t_debt: 'Dług', t_remark: 'Uwaga', t_idea: 'Pomysł', t_change: 'Zmiana',
      now: 'TERAZ', otherSketch: 'Ten widok jest w szkicu {n}', mln: 'mln',
      pos: 'Miejsce w kolejce', of: 'z', after: 'Czeka na', blocks: 'Blokuje', mode: 'Tryb', estimate: 'Szacunek',
      mockups: 'Makiety', yes: 'tak', no: 'nie', readyAt: 'Gotowy od', items: 'Pozycje backlogu', touch: 'dotyka',
      merged: 'Scalony', run: 'Przebieg', files: 'Pliki', tokens: 'Tokeny', estVsActual: 'Szacunek a wynik', uat: 'UAT',
      uat_pending: 'czeka na Twój UAT', 'uat_n/a': 'nie dotyczy', uat_accepted: 'przyjęty', none: 'brak',
      noFile: 'Sam temat — bez pliku sprintu. Szczegóły ustala się przy refinemencie.',
      enNote: 'treść z plików po angielsku — tłumaczenie w budowie',
      sec_Goal: 'Cel', sec_Acceptance: 'Kryteria akceptacji', sec_Decisions: 'Decyzje sprintu', 'sec_Out of scope': 'Poza zakresem',
      sec_Notes: 'Notatki', sec_Journey: 'Ścieżka użytkownika', sec_Mockups: 'Makiety', sec_Estimate: 'Szacunek',
      'sec_Open questions': 'Otwarte pytania', sec_Refs: 'Odwołania',
    },
    en: {
      subtitle: 'Product roadmap', generated: 'Generated', localFile: 'local file, dwmt',
      roadmap: 'Roadmap', backlog: 'Backlog', decisions: 'Decisions', history: 'History', productGoal: 'Product goal:',
      st_topic: 'Topic', st_notes: 'Notes', st_ready: 'Ready', st_ordered: 'Ordered', st_running: 'Running',
      st_done: 'Awaiting review', st_uat: 'Awaiting review', st_closed: 'Closed', st_dropped: 'Dropped',
      k_bugfix: 'Bugfix', k_feature: 'Feature', k_maintenance: 'Maintenance',
      t_bug: 'Bug', t_feature: 'Feature', t_debt: 'Debt', t_remark: 'Remark', t_idea: 'Idea', t_change: 'Change',
      now: 'NOW', otherSketch: 'This view is in sketch {n}', mln: 'M',
      pos: 'Queue position', of: 'of', after: 'Waits for', blocks: 'Blocks', mode: 'Mode', estimate: 'Estimate',
      mockups: 'Mockups', yes: 'yes', no: 'no', readyAt: 'Ready since', items: 'Backlog items', touch: 'touch',
      merged: 'Merged', run: 'Run', files: 'Files', tokens: 'Tokens', estVsActual: 'Estimate vs actual', uat: 'UAT',
      uat_pending: 'awaiting your UAT', 'uat_n/a': 'not applicable', uat_accepted: 'accepted', none: 'none',
      noFile: 'Topic only — no sprint file yet. Details are settled in refinement.',
      enNote: '',
      sec_Goal: 'Goal', sec_Acceptance: 'Acceptance criteria', sec_Decisions: 'Sprint decisions', 'sec_Out of scope': 'Out of scope',
      sec_Notes: 'Notes', sec_Journey: 'User journey', sec_Mockups: 'Mockups', sec_Estimate: 'Estimate',
      'sec_Open questions': 'Open questions', sec_Refs: 'References',
    },
  };
  App.extendT = (pl, en) => { Object.assign(T.pl, pl); Object.assign(T.en, en); };
  const t = (App.t = (k, vars) => {
    let s = T[LANG][k] ?? T.en[k] ?? k;
    if (vars) for (const [a, b] of Object.entries(vars)) s = s.replace('{' + a + '}', b);
    return s;
  });
  App.lang = () => LANG;
  App.tab = () => opts.tab;
  const locale = () => (LANG === 'pl' ? 'pl-PL' : 'en-US');
  const esc = (App.esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])));
  App.goal = (id, text) => (LANG === 'pl' && PL['goal:' + id]) || text;
  App.translated = (id) => LANG !== 'pl' || !!PL['goal:' + id];
  App.fmtM = (x) => (x == null ? '—' : new Intl.NumberFormat(locale(), { maximumFractionDigits: x < 10 ? 2 : 1 }).format(x) + ' ' + t('mln'));
  App.fmtN = (x) => (x == null ? '—' : new Intl.NumberFormat(locale(), { maximumFractionDigits: 2 }).format(x));
  App.fmtDate = (s) => (!s || !/^\d{4}-/.test(s) ? s || '—' : new Intl.DateTimeFormat(locale(), { day: 'numeric', month: 'short' }).format(new Date(s + 'T12:00')));
  const today = new Date(D.generatedAt.slice(0, 10) + 'T12:00');
  App.daysAgo = (s) => Math.round((today - new Date(s + 'T12:00')) / 864e5);

  // ---------- model ----------
  const open = (App.open = D.roadmap.map((r, i) => ({ ...r, pos: i + 1, file: D.sprints[r.id] || null })));
  const openMap = Object.fromEntries(open.map((r) => [r.id, r]));
  const archive = (App.archive = D.archive.map((a) => ({ ...a, dropped: a.merged === 'dropped' })));
  const archMap = Object.fromEntries(archive.map((a) => [a.id, a]));
  const items = Object.fromEntries([...D.backlogArchive, ...D.backlog].map((b) => [b.id, b]));
  const decisions = Object.fromEntries(D.decisions.map((d) => [d.id, d]));
  App.openMap = openMap; App.archMap = archMap; App.items = items; App.decisionsMap = decisions;
  App.current = open.find((r) => r.current) || null;
  App.dependents = (id) => open.filter((r) => r.after.includes(id)).map((r) => r.id);
  App.relations = (id) => new Set([id, ...((openMap[id] || {}).after || []), ...App.dependents(id)]);
  App.uatPending = () => [
    ...open.filter((r) => r.state === 'done').map((r) => ({ id: r.id, goal: r.goal, merged: null, open: true })),
    ...archive.filter((a) => a.uat === 'pending').sort((a, b) => (b.merged || '').localeCompare(a.merged || '')),
  ];
  App.closedSorted = () => archive.filter((a) => a.merged && /^\d/.test(a.merged)).sort((a, b) => b.merged.localeCompare(a.merged));
  App.estRange = (est) => {
    if (!est) return null;
    if (typeof est === 'string' && est.startsWith('start:')) { try { return JSON.parse(est.slice(6)); } catch { return null; } }
    const e = D.estimates.find((x) => x.id === est);
    return e ? e.tokensM : null;
  };
  App.fmtRange = (r) => (r ? App.fmtN(r[0]) + '–' + App.fmtM(r[1]) : '—');
  App.sprintItems = (r) => { const h = (r.file || r.spec || {}).header || {}; return { items: h.items || [], touch: h.touch || [] }; };

  // ---------- small renderers ----------
  App.pill = (state) => `<span class="pill ${state}">${esc(t('st_' + state))}</span>`;
  const KIND_LETTER = { bugfix: 'B', bug: 'B', feature: 'F', maintenance: 'M', debt: 'D', remark: 'R', idea: 'I', change: 'C' };
  App.kind = (k, isItem) => (k ? `<span class="kind ${k}" title="${esc(t((isItem ? 't_' : 'k_') + k))}">${KIND_LETTER[k] || '?'}</span>` : '');
  App.depChip = (id) => {
    const o = openMap[id], a = archMap[id];
    if (o) return `<span class="chip open" data-open="${esc(id)}" title="${esc(App.goal(id, o.goal))}"><span class="dot" style="color:var(--st-${o.state})"></span>${esc(id)}</span>`;
    if (a) return `<span class="chip closed" data-open="${esc(id)}" title="${esc(App.goal(id, a.goal))} · ${esc(App.fmtDate(a.merged))}">✓ ${esc(id)}</span>`;
    return `<span class="chip open">${esc(id)}?</span>`;
  };
  const refTitle = (id) => (items[id] ? items[id].title : decisions[id] ? decisions[id].title : '');
  const inline = (s) => esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\b(AC-\d+)\b/g, '<b>$1</b>')
    .replace(/\b(PD-\d+|B-\d+)\b/g, (m) => `<span class="ref" title="${esc(refTitle(m))}">${m}</span>`);
  App.inline = inline;
  App.text = (txt) => {
    const out = []; let list = null;
    for (const line of String(txt || '').split('\n')) {
      if (/^\s*- /.test(line)) { if (!list) { list = []; out.push(list); } list.push(line.replace(/^\s*- /, '')); }
      else if (line.trim()) { list = null; out.push(line); }
    }
    return out.map((b) => (Array.isArray(b) ? '<ul>' + b.map((l) => `<li>${inline(l)}</li>`).join('') + '</ul>' : `<p>${inline(b)}</p>`)).join('');
  };
  const enMark = () => (LANG === 'pl' ? `<span class="en-badge" title="${esc(t('enNote'))}">EN</span>` : '');
  App.enMark = enMark;

  // ---------- drawer ----------
  const SECTION_ORDER = ['Goal', 'Acceptance', 'Decisions', 'Out of scope', 'Journey', 'Mockups', 'Notes', 'Estimate', 'Open questions'];
  function itemList(ids, label) {
    if (!ids.length) return '';
    return `<div class="dsec"><h3>${esc(label)} (${ids.length})${enMark()}</h3>${ids.map((id) => {
      const b = items[id];
      if (!b) return `<div class="item-row"><span class="id">${esc(id)}</span></div>`;
      return `<div class="item-row">${App.kind(b.type, true)}<span class="id">${esc(id)}</span><span>${esc(b.title)}</span>${b.sev ? `<span class="pill ${b.sev === 'major' || b.sev === 'blocker' ? 'done' : 'topic'}">${esc(b.sev)}</span>` : ''}</div>`;
    }).join('')}</div>`;
  }
  function sections(spec, skipGoal) {
    if (!spec) return '';
    const s = spec.sections || {};
    const keys = [...SECTION_ORDER.filter((k) => s[k]), ...Object.keys(s).filter((k) => !SECTION_ORDER.includes(k) && k !== 'Refs')];
    let html = keys.filter((k) => !(skipGoal && k === 'Goal')).map((k) => `<div class="dsec"><h3>${esc(t('sec_' + k))}${enMark()}</h3>${App.text(s[k])}</div>`).join('');
    const pds = [...new Set(((s.Refs || '') + ' ' + (s.Decisions || '')).match(/PD-\d+/g) || [])];
    if (pds.length) html += `<div class="dsec"><h3>${esc(t('decisions'))} (${pds.length})${enMark()}</h3>${pds.map((id) => {
      const d = decisions[id];
      return `<div class="item-row"><span class="id">${id}</span><span>${d ? `<b>${esc(d.title)}</b> — ${inline(d.Decision || '')}` : ''}</span></div>`;
    }).join('')}</div>`;
    return html;
  }
  App.openDrawer = (id) => {
    const o = openMap[id], a = archMap[id];
    if (!o && !a) return;
    const r = o || a;
    const spec = o ? o.file : a.spec;
    const h = (spec && spec.header) || {};
    const state = o ? o.state : a.dropped ? 'dropped' : a.uat === 'pending' ? 'uat' : 'closed';
    let facts = '';
    if (o) {
      facts += `<dt>${t('pos')}</dt><dd>${o.pos} ${t('of')} ${open.length}</dd>`;
      facts += `<dt>${t('after')}</dt><dd>${o.after.length ? o.after.map(App.depChip).join('') : '<span class="subtle">' + t('none') + '</span>'}</dd>`;
      const dep = App.dependents(id);
      if (dep.length) facts += `<dt>${t('blocks')}</dt><dd>${dep.map(App.depChip).join('')}</dd>`;
      if (spec) {
        facts += `<dt>${t('mode')}</dt><dd>${esc(h.mode || '—')}</dd>`;
        facts += `<dt>${t('estimate')}</dt><dd class="num">${App.fmtRange(App.estRange(h.est))}</dd>`;
        facts += `<dt>${t('mockups')}</dt><dd>${h.ui ? t('yes') : t('no')}</dd>`;
        if (h.ready) facts += `<dt>${t('readyAt')}</dt><dd>${App.fmtDate(h.ready.at)}</dd>`;
      }
    } else {
      facts += `<dt>${t('merged')}</dt><dd>${a.dropped ? t('st_dropped') : App.fmtDate(a.merged)}</dd>`;
      if (a.run) facts += `<dt>${t('run')}</dt><dd><span class="id">${esc(a.run)}</span></dd>`;
      if (a.files != null) facts += `<dt>${t('files')}</dt><dd class="num">${a.files}</dd>`;
      if (a.tokensM != null) facts += `<dt>${t('tokens')}</dt><dd class="num">${App.fmtM(a.tokensM)}</dd>`;
      const rg = App.estRange(a.est);
      if (rg && a.tokensM != null) {
        const max = Math.max(rg[1], a.tokensM) * 1.1;
        facts += `<dt>${t('estVsActual')}</dt><dd><div class="range" style="width:180px"><div class="band" style="left:${(rg[0] / max) * 100}%;width:${((rg[1] - rg[0]) / max) * 100}%"></div><div class="mark" style="left:${(a.tokensM / max) * 100}%"></div></div><span class="num subtle">${App.fmtRange(rg)}</span></dd>`;
      }
      if (a.uat) facts += `<dt>${t('uat')}</dt><dd>${esc(t('uat_' + a.uat))}</dd>`;
    }
    const { items: its, touch } = App.sprintItems(r);
    document.getElementById('drawer-content').innerHTML = `
      <div class="drawer-head">
        <div class="row"><span class="id">${esc(id)}</span>${App.pill(state)}${App.kind(h.kind)}${o && o.current ? `<span class="now-badge">▶ ${t('now')}</span>` : ''}
          <button class="drawer-close" onclick="App.closeDrawer()" aria-label="close">×</button></div>
        <h2>${esc(App.goal(id, r.goal))}${App.translated(id) ? '' : enMark()}</h2>
      </div>
      <div class="drawer-body">
        <dl class="facts">${facts}</dl>
        ${spec ? '' : `<p class="muted">${t('noFile')}</p>`}
        ${spec && spec.sections.Goal ? `<div class="dsec"><h3>${t('sec_Goal')}${enMark()}</h3>${App.text(spec.sections.Goal)}</div>` : ''}
        ${itemList(its, t('items'))}${itemList(touch, t('items') + ' — ' + t('touch'))}
        ${sections(spec, true)}
      </div>`;
    document.querySelector('.drawer').classList.add('open');
    document.querySelector('.drawer-overlay').classList.add('open');
  };
  App.closeDrawer = () => {
    document.querySelector('.drawer').classList.remove('open');
    document.querySelector('.drawer-overlay').classList.remove('open');
  };

  // ---------- header ----------
  const visionGoal = () => {
    if (LANG === 'pl' && PL.vision) return PL.vision;
    const m = (D.vision || '').match(/Optimization goal:\s*([^.]*\.)/);
    return m ? m[1] : '';
  };
  App.header = (active) => {
    const tabs = [
      ['roadmap', open.length], ['backlog', D.backlog.length], ['decisions', D.decisions.length], ['history', App.closedSorted().length],
    ];
    return `<header class="app-header">
      <div class="app-top"><div class="app-logo">dw</div>
        <div class="app-title">${esc(D.project)}<small>${t('subtitle')}</small></div>
        <div class="app-meta"><span>${t('generated')}: ${esc(D.generatedAt)}</span><span>${t('localFile')}</span></div></div>
      <nav class="app-tabs">${tabs.map(([k, n]) => `<button class="app-tab ${k === active ? 'active' : ''}" data-tab="${k}">${t(k)}<span class="count">${n}</span></button>`).join('')}</nav>
      <div class="goal-banner"><span>${t('productGoal')}</span><b>${esc(visionGoal())}</b></div>
    </header>`;
  };

  // ---------- hover relations ----------
  App.bindRelations = (root) => {
    if (root.dataset.rel) return;
    root.dataset.rel = '1';
    root.addEventListener('mouseover', (e) => {
      const el = e.target.closest('[data-sprint]');
      if (!el || !root.contains(el)) return;
      const rel = App.relations(el.dataset.sprint);
      root.querySelectorAll('[data-sprint]').forEach((x) => x.classList.toggle('dep-hi', rel.has(x.dataset.sprint) && x !== el));
    });
    root.addEventListener('mouseleave', () => root.querySelectorAll('.dep-hi').forEach((x) => x.classList.remove('dep-hi')));
  };

  // ---------- toast ----------
  App.toast = (msg) => {
    const el = document.getElementById('toast');
    el.textContent = msg; el.classList.add('show');
    clearTimeout(App._tt); App._tt = setTimeout(() => el.classList.remove('show'), 1800);
  };

  // ---------- sketch chrome ----------
  App.selectVariant = (id) => {
    document.querySelectorAll('.variant').forEach((v) => (v.style.display = v.id === 'variant-' + id ? 'block' : 'none'));
    document.querySelectorAll('.variant-tab').forEach((b) => b.classList.toggle('active', b.dataset.v === id));
    App.active = id;
    const v = opts.variants.find((x) => x.id === id);
    if (v.after) v.after(document.getElementById('variant-' + id));
  };
  App.render = () => {
    document.getElementById('app-header').innerHTML = App.header(opts.tab);
    for (const v of opts.variants) {
      const el = document.getElementById('variant-' + v.id);
      el.innerHTML = v.render();
      if (v.after && App.active === v.id) v.after(el);
    }
  };
  App.init = (o) => {
    opts = o;
    document.body.insertAdjacentHTML('afterbegin', `
      <div id="variant-nav"><span class="label">Sketch ${o.sketch}</span>${o.variants.map((v) => `<button class="variant-tab" data-v="${v.id}">${esc(v.label)}${v.winner ? ' ★' : ''}</button>`).join('')}</div>
      <div id="frame"><div id="app-header"></div>${o.variants.map((v) => `<div class="variant" id="variant-${v.id}" style="display:none"></div>`).join('')}</div>
      <div class="drawer-overlay" onclick="App.closeDrawer()"></div><aside class="drawer" id="drawer-content"></aside>
      <div id="toast"></div><div id="anno-tip"></div>
      <div id="sketch-tools">
        <select id="theme-sel" title="theme"><option value="default">Jasny</option><option value="dark">Ciemny</option></select>
        <span>|</span>${['375', '768', '1280', 'full'].map((w) => `<button data-w="${w}" class="${w === 'full' ? 'on' : ''}">${w}</button>`).join('')}
        <span>|</span><button id="anno-btn">Anno</button>
        <span>|</span><button data-lang="pl" class="${LANG === 'pl' ? 'on' : ''}">PL</button><button data-lang="en" class="${LANG === 'en' ? 'on' : ''}">EN</button>
      </div>`);
    document.getElementById('variant-nav').addEventListener('click', (e) => { const b = e.target.closest('.variant-tab'); if (b) App.selectVariant(b.dataset.v); });
    document.getElementById('theme-sel').onchange = (e) => (document.querySelector('link[href*=themes]').href = '../themes/' + e.target.value + '.css');
    const tools = document.getElementById('sketch-tools');
    tools.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.w) {
        tools.querySelectorAll('[data-w]').forEach((x) => x.classList.toggle('on', x === b));
        document.getElementById('frame').style.maxWidth = b.dataset.w === 'full' ? '' : b.dataset.w + 'px';
        if (App.active) App.selectVariant(App.active);
      } else if (b.dataset.lang) {
        LANG = b.dataset.lang;
        tools.querySelectorAll('[data-lang]').forEach((x) => x.classList.toggle('on', x === b));
        App.render();
      } else if (b.id === 'anno-btn') { b.classList.toggle('on'); App.anno = b.classList.contains('on'); if (!App.anno) document.getElementById('anno-tip').style.display = 'none'; }
    });
    document.addEventListener('mousemove', (e) => {
      if (!App.anno) return;
      const tip = document.getElementById('anno-tip'), cs = getComputedStyle(e.target);
      tip.textContent = `${e.target.tagName.toLowerCase()}.${[...e.target.classList].join('.')}\nfont ${cs.fontSize} ${cs.fontWeight}\ncolor ${cs.color}\nbg ${cs.backgroundColor}\npad ${cs.padding}`;
      tip.style.display = 'block'; tip.style.left = e.clientX + 14 + 'px'; tip.style.top = e.clientY + 14 + 'px';
    });
    document.addEventListener('click', (e) => {
      const tab = e.target.closest('.app-tab');
      if (tab && tab.dataset.tab !== opts.tab) {
        if (opts.tabSketch[tab.dataset.tab] === 'here') { opts.tab = tab.dataset.tab; return App.render(); }
        return App.toast(t('otherSketch', { n: opts.tabSketch[tab.dataset.tab] || '?' }));
      }
      const op = e.target.closest('[data-open]');
      if (op) { e.stopPropagation(); return App.openDrawer(op.dataset.open); }
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') App.closeDrawer(); });
    window.addEventListener('resize', () => { if (App.active) { const v = opts.variants.find((x) => x.id === App.active); if (v.after) v.after(document.getElementById('variant-' + App.active)); } });
    App.render();
    App.selectVariant(o.variants[0].id);
  };
})();
