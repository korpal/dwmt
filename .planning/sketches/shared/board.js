// Board with human statuses and the human sprint panel (drawer / modal / page). Needs app.js first.
(function () {
  const { esc, t } = App;
  const D = App.D, H = window.DWMT_HUMAN || {};
  App.extendT({
    st_draft: 'Draft', st_todo: 'Do zrobienia', st_inprogress: 'W toku', st_uat: 'Czeka na przegląd',
    h_draft: 'jest pomysł, ale jeszcze nie wiadomo, o co dokładnie chodzi', h_todo: 'wiadomo, o co chodzi; PO bierze od góry', h_inprogress: 'zlecone albo przebieg trwa', h_uat: 'scalone; UAT albo przegląd kodu, potem przyjęcie',
    nextBadge: 'następny', goBadge: 'może iść bez Ciebie', runOrdered: 'czeka na start', runRunning: 'przebieg trwa', afterLbl: 'po',
    need_mockup: 'brak makiety', need_price: 'bez ceny', need_answers: 'pytania do Ciebie',
    p_why: 'Po co', p_changes: 'Co się zmieni', p_not: 'Czego nie będzie', p_check: 'Jak sprawdzić', p_you: 'Od Ciebie', p_queue: 'Kolejka',
    p_after: 'Najpierw musi być zrobiony', p_scale: 'Skala', p_mockups: 'Makiety', p_decisions: 'Ustalenia', p_result: 'Wynik',
    p_tech: 'Szczegóły techniczne (plik sprintu dla agentów)', p_goalFile: 'Cel z pliku sprintu', p_notes: 'Notatki',
    you_draft: 'Opowiedz PO, o co chodzi — to jeszcze szkic pomysłu.', you_mockup: 'Makieta do zrobienia (poza dwmt).', you_price: 'Cena — PO poda ją, gdy weźmie sprint.',
    you_answers: 'Odpowiedzi na pytania: {n}.', you_ok: 'Nic — może iść bez Ciebie.', you_run: 'Nic. Jeśli przebieg zada pytanie, PO Cię zawoła.',
    you_uat: 'Przejrzyj i przyjmij: kroki w sekcji „Jak sprawdzić”.', you_uatNoSteps: 'Przejrzyj i przyjmij. Kroki poda PO, gdy powiesz „zróbmy UAT”.', you_closed: 'Nic — zamknięty.',
    q_pos: '{n}. w kolumnie „{c}”', mockPending: 'do zrobienia', est: 'Cena startu', analog: 'Podobne zamknięte (analogia)', none2: 'brak',
    noHuman: 'PO nie napisał jeszcze opisu dla Ciebie — niżej treść z pliku sprintu (po angielsku, dla agentów).',
    noHumanDraft: 'Sam pomysł. Opis dla Ciebie powstanie, gdy z PO ustalicie, o co chodzi.',
    back: 'Roadmapa', prev: '← Poprzedni', nextBtn: 'Następny →', close: 'Zamknij', mergedOn: 'Scalony', filesN: 'plików',
    sum_backlog: 'Backlog', sum_bugs: 'błędy', sum_major: 'poważne', showLess: 'Zwiń', more: '+{n} więcej',
  }, {
    st_draft: 'Draft', st_todo: 'To do', st_inprogress: 'In progress', st_uat: 'Awaiting review',
    h_draft: 'an idea; not yet clear what exactly it is', h_todo: 'clear; the PO takes from the top', h_inprogress: 'ordered or running', h_uat: 'merged; UAT or code review, then accept',
    nextBadge: 'next', goBadge: 'can go without you', runOrdered: 'waiting to start', runRunning: 'running', afterLbl: 'after',
    need_mockup: 'no mockup', need_price: 'no price', need_answers: 'questions for you',
    p_why: 'Why', p_changes: 'What changes', p_not: 'Not included', p_check: 'How to check', p_you: 'From you', p_queue: 'Queue',
    p_after: 'Must be done first', p_scale: 'Scale', p_mockups: 'Mockups', p_decisions: 'Decisions', p_result: 'Result',
    p_tech: 'Technical details (sprint file for agents)', p_goalFile: 'Goal from the sprint file', p_notes: 'Notes',
    you_draft: 'Tell the PO what it is about — still an idea.', you_mockup: 'Mockup to be made (outside dwmt).', you_price: 'Price — the PO gives it when taking the sprint.',
    you_answers: 'Answers to questions: {n}.', you_ok: 'Nothing — can go without you.', you_run: 'Nothing. If the run asks, the PO will call you.',
    you_uat: 'Review and accept: steps under "How to check".', you_uatNoSteps: 'Check and accept. The PO gives the steps when you say "let\'s do UAT".', you_closed: 'Nothing — closed.',
    q_pos: '{n}. in "{c}"', mockPending: 'to be made', est: 'Start price', analog: 'Similar closed (analogy)', none2: 'none',
    noHuman: 'The PO has not written a description for you yet — below is the sprint file text (for agents).',
    noHumanDraft: 'Just an idea. The description appears once you and the PO settle what it is about.',
    back: 'Roadmap', prev: '← Previous', nextBtn: 'Next →', close: 'Close', mergedOn: 'Merged', filesN: 'files',
    sum_backlog: 'Backlog', sum_bugs: 'bugs', sum_major: 'major', showLess: 'Collapse', more: '+{n} more',
  });

  const COLS = ['draft', 'todo', 'inprogress', 'uat'];
  const LOCK = '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M4 7V5a4 4 0 0 1 8 0v2h1v8H3V7h1zm2 0h4V5a2 2 0 0 0-4 0v2z"/></svg>';
  const acc = (spec) => spec && (spec.sections.Acceptance || spec.sections['Acceptance criteria']);
  // Sketch stand-in for the new "clear" marker: a sprint file with acceptance criteria counts as "to do".
  App.hstatus = (r) => (r.state === 'ordered' || r.state === 'running' ? 'inprogress' : r.state === 'done' ? 'uat' : r.state === 'ready' || acc(r.file) ? 'todo' : 'draft');
  App.htitle = (id, goal) => (H[id] && H[id].title) || App.goal(id, goal);
  const hasHuman = (id) => !!H[id];
  App.openAfter = (r) => r.after.filter((a) => App.openMap[a] && App.openMap[a].state !== 'done');
  const head = (r) => ((r.file || r.spec || {}).header || {});
  function needs(r) {
    if (r.state === 'ready') return [];
    const s = (r.file || {}).sections || {}, h = head(r), out = [];
    if (h.ui && !/\.planning\/sketches\//.test(s.Mockups || '')) out.push('mockup');
    if (!h.est) out.push('price');
    const q = (s['Open questions'] || '').split('\n').filter((l) => /^\s*- /.test(l) && !/\[architect\]/.test(l));
    if (q.length) out.push('answers');
    return out;
  }
  function columns() {
    const cols = Object.fromEntries(COLS.map((c) => [c, []]));
    App.open.forEach((r) => cols[App.hstatus(r)].push(r));
    return cols;
  }

  // ---------- board ----------
  function bcard(r, col, i) {
    const h = head(r);
    const cls = ['bcard', col === 'draft' ? 'draft' : '', col === 'todo' && i === 0 ? 'next' : '', col === 'inprogress' ? 'running' : ''].join(' ');
    let right = '';
    if (col === 'todo' && i === 0) right += `<span class="badge next">${t('nextBadge')}</span>`;
    if (col === 'inprogress') right += `<span class="badge run">${t(r.state === 'running' ? 'runRunning' : 'runOrdered')}</span>`;
    const foot = App.openAfter(r).map((a) => `<span class="after-chip" data-open="${esc(a)}" title="${esc(App.htitle(a, App.openMap[a].goal))}">${LOCK}${t('afterLbl')}: ${esc(a)}</span>`);
    if (col === 'todo') {
      if (r.state === 'ready') foot.push(`<span class="badge go">✓ ${t('goBadge')}</span>`);
      else needs(r).forEach((n) => foot.push(`<span class="badge need">${t('need_' + n)}</span>`));
    }
    const enm = hasHuman(r.id) || App.translated(r.id) ? '' : App.enMark();
    return `<div class="${cls}" data-open="${esc(r.id)}">
      <div class="top">${col === 'todo' ? `<span class="ord">${i + 1}.</span>` : ''}<span class="id">${esc(r.id)}</span>${App.kind(h.kind)}<span class="right">${right}</span></div>
      <div class="title">${esc(App.htitle(r.id, r.goal))}${enm}</div><div class="foot">${foot.join('')}</div></div>`;
  }
  function ucard(a) {
    return `<div class="bcard compact" data-open="${esc(a.id)}"><div class="top"><span class="id">${esc(a.id)}</span><span class="right subtle">${a.merged ? App.fmtDate(a.merged) : ''}</span></div>
      <div class="title">${esc(App.htitle(a.id, a.goal))}</div></div>`;
  }
  App.boardUi = { more: false };
  App.renderBoard = () => {
    const cols = columns();
    const uatArch = App.uatPending().filter((u) => !u.open);
    const shown = App.boardUi.more ? uatArch : uatArch.slice(0, 6);
    const B = D.backlog;
    const n = (c) => cols[c].length + (c === 'uat' ? uatArch.length : 0);
    const strip = `<div class="stats">
      <div class="grp">${['todo', 'inprogress', 'uat', 'draft'].map((c) => `${App.pill(c)}<b>${n(c)}</b>`).join('')}</div><div class="sep"></div>
      <div class="grp"><span class="muted">${t('sum_backlog')}</span><b>${B.length}</b><span>${App.kind('bug', true)} ${t('sum_bugs')} <b>${B.filter((b) => b.type === 'bug').length}</b></span>
      <span>${t('sum_major')} <b>${B.filter((b) => b.sev === 'major' || b.sev === 'blocker').length}</b></span></div></div>`;
    return `<div class="page">${strip}<div class="board2">${COLS.map((c) => `<div class="col"><div class="col-head">${App.pill(c)}<span class="n">${n(c)}</span></div>
      <div class="col-hint">${t('h_' + c)}</div><div class="col-body">${cols[c].map((r, i) => bcard(r, c, i)).join('')}
      ${c === 'uat' ? shown.map(ucard).join('') + (uatArch.length > 6 ? `<button class="link-btn" onclick="App.boardUi.more=!App.boardUi.more;App.render()">${App.boardUi.more ? t('showLess') : t('more', { n: uatArch.length - 6 })}</button>` : '') : ''}
      </div></div>`).join('')}</div></div>`;
  };

  // ---------- human panel ----------
  const list = (arr, cls) => `<ul class="hp-list ${cls}">${arr.map((x) => `<li>${App.inline(x)}</li>`).join('')}</ul>`;
  const stripIds = (txt) => String(txt || '').split('\n').filter((l) => /^\s*- /.test(l)).map((l) => l.replace(/^\s*- /, '').replace(/^AC-\d+\s*/, ''));
  function analogs(r, kind) {
    const cnt = (head(r).items || []).length;
    return App.closedSorted().filter((a) => a.tokensM != null && a.kind === kind && a.id !== r.id)
      .map((a) => ({ a, d: Math.abs(((head(a).items) || []).length - cnt) })).sort((x, y) => x.d - y.d).slice(0, 2).map((x) => x.a);
  }
  App.humanPanel = (id) => {
    const o = App.openMap[id], a = App.archMap[id], r = o || a;
    const spec = o ? o.file : a.spec, s = (spec && spec.sections) || {}, h = head(r), hh = H[id];
    const st = o ? App.hstatus(o) : a.uat === 'pending' ? 'uat' : a.dropped ? 'dropped' : 'closed';
    const enm = hasHuman(id) || App.translated(id) ? '' : App.enMark();
    const headHtml = `<div class="hp-head"><div class="row">${App.pill(st)}<span class="id">${esc(id)}</span>${App.kind(h.kind)}</div>
      <div class="hp-title">${esc(App.htitle(id, r.goal))}${enm}</div></div>`;

    let main = '';
    if (hh) {
      main += `<p class="hp-why">${App.inline(hh.why)}</p>`;
      if (hh.changes) main += `<div class="hp-sec"><h3>${t('p_changes')}</h3>${list(hh.changes, 'changes')}</div>`;
      if (hh.notIncluded) main += `<div class="hp-sec"><h3>${t('p_not')}</h3>${list(hh.notIncluded, 'not')}</div>`;
      if (hh.check && st === 'uat') main += `<div class="hp-sec"><h3>${t('p_check')}</h3>${list(hh.check, 'steps')}</div>`;
    } else if (st === 'draft') {
      main += `<div class="hp-missing">${t('noHumanDraft')}</div>`;
      if (s.Notes && s.Notes.replace(/[-\s]/g, '')) main += `<div class="hp-sec"><h3>${t('p_notes')}${App.enMark()}</h3>${App.text(s.Notes)}</div>`;
    } else {
      main += `<div class="hp-missing">${t('noHuman')}</div>`;
      if (s.Goal) main += `<div class="hp-sec"><h3>${t('p_goalFile')}${App.enMark()}</h3>${App.text(s.Goal)}</div>`;
      const ch = stripIds(acc(spec));
      if (ch.length) main += `<div class="hp-sec"><h3>${t('p_changes')}${App.enMark()}</h3>${list(ch, 'changes')}</div>`;
      const nt = stripIds(s['Out of scope']);
      if (nt.length) main += `<div class="hp-sec"><h3>${t('p_not')}${App.enMark()}</h3>${list(nt, 'not')}</div>`;
    }

    // "From you" box
    let you, ok = false;
    if (st === 'draft') you = [t('you_draft')];
    else if (st === 'todo') {
      const ns = needs(o);
      you = ns.map((x) => (x === 'mockup' ? t('you_mockup') : x === 'price' ? t('you_price') : t('you_answers', { n: 1 })));
      if (!you.length) { you = [t('you_ok')]; ok = true; }
    } else if (st === 'inprogress') { you = [t('you_run')]; ok = true; }
    else if (st === 'uat') you = [hh && hh.check ? t('you_uat') : t('you_uatNoSteps')];
    else { you = [t('you_closed')]; ok = true; }
    const youHtml = `<div class="hp-box you ${ok ? 'ok' : ''}"><h4>${t('p_you')}</h4><ul>${you.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>`;

    let facts = '';
    if (o && st !== 'uat') {
      const col = columns()[st], idx = col.indexOf(o);
      const aft = App.openAfter(o);
      facts += `<div class="hp-box"><h4>${t('p_queue')}</h4><div>${t('q_pos', { n: idx + 1, c: t('st_' + st) })}</div>
        ${aft.length ? `<div style="margin-top:6px" class="muted">${t('p_after')}:</div>${aft.map((x) => `<div><span class="after-chip" data-open="${esc(x)}">${LOCK}${esc(x)}</span> ${esc(App.htitle(x, App.openMap[x].goal))}</div>`).join('')}` : ''}</div>`;
    }
    if (a && a.tokensM != null) {
      const rg = App.estRange(a.est);
      facts += `<div class="hp-box"><h4>${t('p_result')}</h4><div class="line"><span>${t('mergedOn')}</span><b>${App.fmtDate(a.merged)}</b></div>
        <div class="line"><span>${t('files')}</span><b class="num">${a.files}</b></div><div class="line"><span>${t('tokens')}</span><b class="num">${App.fmtM(a.tokensM)}</b></div>
        ${rg ? `<div class="line"><span>${t('est')}</span><span class="num muted">${App.fmtRange(rg)}</span></div>` : ''}</div>`;
    } else if (st !== 'draft') {
      const rg = App.estRange(h.est), an = analogs(r, h.kind);
      facts += `<div class="hp-box"><h4>${t('p_scale')}</h4>${rg ? `<div class="line"><span>${t('est')}</span><b class="num">${App.fmtRange(rg)}</b></div>` : ''}
        ${an.length ? `<div class="muted" style="font-size:var(--text-sm)">${t('analog')}:</div>${an.map((x) => `<div class="line"><span class="chip" data-open="${esc(x.id)}">${esc(x.id)}</span><span class="num">${x.files} ${t('filesN')} · ${App.fmtM(x.tokensM)}</span></div>`).join('')}` : ''}</div>`;
    }
    if (h.ui) {
      const m = (s.Mockups || '').match(/\.planning\/sketches\/[\w.-]+[^\n]*/g) || [];
      facts += `<div class="hp-box"><h4>${t('p_mockups')}</h4>${m.length ? m.map((line) => {
        const p = line.match(/\.planning\/sketches\/[\w.-]+/)[0], rest = line.slice(p.length).replace(/^[\s;,]+/, '');
        return `<div><a href="file:///${esc(D.root)}/${esc(p)}/index.html" target="_blank">${esc(p.split('/').pop())}</a> <span class="muted">${esc(rest)}</span>${App.enMark()}</div>`;
      }).join('') : `<div class="muted">${t('mockPending')}</div>`}</div>`;
    }
    const pds = [...new Set(((s.Refs || '') + ' ' + (s.Decisions || '') + ' ' + (s.Goal || '')).match(/PD-\d+/g) || [])];
    if (pds.length) facts += `<div class="hp-box"><h4>${t('p_decisions')}</h4><ul>${pds.map((p) => { const d = App.decisionsMap[p];
      return `<li title="${esc(d ? d.Decision : '')}">${esc(d ? d.title : p)}${App.enMark()}</li>`; }).join('')}</ul></div>`;

    // technical details: the agent file as is
    const items = [...(h.items || []), ...(h.touch || [])];
    const tech = spec ? `<details class="hp-tech"><summary>${t('p_tech')}</summary>
      ${items.length ? `<div class="dsec"><h3>${t('items')}</h3>${items.map((i) => { const b = App.items[i]; return `<div class="item-row">${b ? App.kind(b.type, true) : ''}<span class="id">${esc(i)}</span><span>${esc(b ? b.title : '')}</span></div>`; }).join('')}</div>` : ''}
      ${Object.entries(spec.sections).map(([k, v]) => `<div class="dsec"><h3>${esc(k)}</h3>${App.text(v)}</div>`).join('')}</details>` : '';
    return { head: headHtml, main, you: youHtml, facts, tech };
  };

  // ---------- panel modes ----------
  App.panelMode = 'modal'; // 002 winner: centred card
  App.pageId = null;
  const baseClose = App.closeDrawer;
  App.closeDrawer = () => {
    baseClose();
    document.querySelectorAll('.modal-wrap').forEach((m) => m.remove());
    if (App.pageId) { App.pageId = null; App.render(); window.scrollTo(0, 0); }
  };
  App.showModal = (headHtml, mainHtml, sideHtml) => {
    baseClose();
    document.querySelectorAll('.modal-wrap').forEach((m) => m.remove());
    document.body.insertAdjacentHTML('beforeend', `<div class="modal-wrap"><div class="modal"><div class="m-head"><div style="flex:1">${headHtml}</div>
      <button class="drawer-close" onclick="App.closeDrawer()" aria-label="${t('close')}">×</button></div>
      <div class="m-body"><div>${mainHtml}</div><div class="hp-side">${sideHtml}</div></div></div></div>`);
    document.querySelector('.drawer-overlay').classList.add('open');
    requestAnimationFrame(() => document.querySelector('.modal').classList.add('open'));
  };
  App.openDrawer = (id) => {
    if (!App.openMap[id] && !App.archMap[id]) return;
    const p = App.humanPanel(id);
    if (App.panelMode === 'page') { baseClose(); document.querySelectorAll('.modal-wrap').forEach((m) => m.remove()); App.pageId = id; App.render(); window.scrollTo(0, 0); return; }
    if (App.panelMode === 'modal') return App.showModal(p.head, p.main + p.tech, p.you + p.facts);
    document.getElementById('drawer-content').innerHTML = `<div class="drawer-head"><div class="row" style="align-items:flex-start"><div style="flex:1">${p.head}</div>
      <button class="drawer-close" onclick="App.closeDrawer()" aria-label="${t('close')}">×</button></div></div>
      <div class="drawer-body"><div class="hp-side" style="margin-top:var(--space-3)">${p.you}</div>${p.main}<div class="hp-side" style="margin-top:var(--space-5)">${p.facts}</div>${p.tech}</div>`;
    document.querySelector('.drawer').classList.add('open');
    document.querySelector('.drawer-overlay').classList.add('open');
  };
  App.renderPage = () => {
    const id = App.pageId, p = App.humanPanel(id);
    const ids = App.open.map((r) => r.id), i = ids.indexOf(id);
    return `<div class="spage"><div class="crumb"><button onclick="App.closeDrawer()">${t('back')}</button><span>›</span><span class="id">${esc(id)}</span></div>
      <div class="s-card"><div class="s-head" style="display:flex;gap:var(--space-3);align-items:flex-start"><div style="flex:1">${p.head}</div>
        <div class="s-nav"><button ${i <= 0 ? 'disabled' : ''} onclick="App.openDrawer('${i > 0 ? ids[i - 1] : ''}')">${t('prev')}</button>
        <button ${i < 0 || i >= ids.length - 1 ? 'disabled' : ''} onclick="App.openDrawer('${i >= 0 && i < ids.length - 1 ? ids[i + 1] : ''}')">${t('nextBtn')}</button></div></div>
      <div class="s-body"><div>${p.main}${p.tech.replace('<details', '<details open')}</div><div class="hp-side">${p.you}${p.facts}</div></div></div></div>`;
  };
})();
