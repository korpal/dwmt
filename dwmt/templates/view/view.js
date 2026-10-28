// dwmt product view (read-only, generated): roadmap board, sprint card, backlog and decisions in groups, history charts.
// Data: the JSON block `dwmt-data` written by `dwmt product view`. No network; works over file://.
(function () {
  'use strict';
  const D = JSON.parse(document.getElementById('dwmt-data').textContent);
  const CL = String(D.language || 'en').toLowerCase();
  const store = {
    get: (k) => { try { return localStorage.getItem('dwmt-view:' + k); } catch (e) { return null; } },
    set: (k, v) => { try { localStorage.setItem('dwmt-view:' + k, v); } catch (e) { /* private mode */ } },
  };
  const LANGS = CL === 'en' ? ['pl', 'en'] : [CL, 'en'];
  let LANG = LANGS.includes(store.get('lang')) ? store.get('lang') : CL === 'en' ? 'en' : CL;

  // ---------- UI strings ----------
  const T = {
    pl: {
      subtitle: 'Roadmapa produktu', generated: 'Wygenerowano', readOnly: 'plik lokalny, tylko do odczytu', productGoal: 'Cel produktu:',
      roadmap: 'Roadmapa', backlog: 'Backlog', decisions: 'Decyzje', history: 'Historia',
      st_draft: 'Draft', st_todo: 'Do zrobienia', st_inprogress: 'W toku', st_review: 'Czeka na przegląd', st_closed: 'Zamknięty', st_dropped: 'Porzucony',
      h_draft: 'jest pomysł, ale jeszcze nie wiadomo, o co dokładnie chodzi', h_todo: 'wiadomo, o co chodzi; PO bierze od góry', h_inprogress: 'zlecone albo przebieg trwa', h_review: 'scalone; UAT albo przegląd kodu, potem przyjęcie',
      k_bugfix: 'Poprawka', k_feature: 'Funkcja', k_maintenance: 'Utrzymanie',
      ty_bug: 'Błąd', ty_feature: 'Funkcja', ty_debt: 'Dług', ty_remark: 'Uwaga', ty_idea: 'Pomysł', ty_change: 'Zmiana', ty_mockups: 'Makiety',
      nextBadge: 'następny', goBadge: 'może iść bez Ciebie', runOrdered: 'czeka na start', runRunning: 'przebieg trwa', afterLbl: 'po', now: 'teraz',
      need_mockup: 'brak makiety', need_price: 'bez ceny', need_answers: 'pytania do Ciebie', halt_stopped: 'zatrzymany', halt_waiting: 'pytanie do Ciebie',
      you_halt_stopped: 'Przebieg stoi ({r}). Powiedz PO, czy wznowić.', you_halt_waiting: 'Przebieg czeka na Twoją odpowiedź: {r}',
      p_changes: 'Co się zmieni', p_not: 'Czego nie będzie', p_check: 'Jak sprawdzić', p_you: 'Od Ciebie', p_queue: 'Kolejka', p_after: 'Najpierw musi być zrobiony',
      p_scale: 'Skala', p_mockups: 'Makiety', p_decisions: 'Ustalenia', p_result: 'Wynik', p_goalFile: 'Cel z pliku sprintu', p_notes: 'Notatki',
      p_tech: 'Szczegóły techniczne (plik sprintu dla agentów)', p_items: 'Pozycje backlogu', p_touch: 'przy okazji', p_header: 'Nagłówek', p_mode: 'Tryb', p_readyAt: 'Gotowy od', p_run: 'Przebieg',
      you_draft: 'Opowiedz PO, o co chodzi — to jeszcze szkic pomysłu.', you_mockup: 'Makieta do zrobienia.', you_price: 'Cena — PO poda ją, gdy weźmie sprint.',
      you_answers: 'Odpowiedzi na pytania: {n}.', you_ok: 'Nic — może iść bez Ciebie.', you_run: 'Nic. Jeśli przebieg zada pytanie, PO Cię zawoła.',
      you_uat: 'Przejrzyj i przyjmij: kroki w sekcji „Jak sprawdzić”.', you_uatNoSteps: 'Przejrzyj i przyjmij. Kroki poda PO, gdy powiesz „zróbmy UAT”.', you_closed: 'Nic — zamknięty.',
      q_pos: '{n}. w kolumnie „{c}”', q_roadmap: '{n}. z {m} w roadmapie', mockPending: 'do zrobienia', est: 'Cena startu', analog: 'Podobne zamknięte', filesN: 'plików',
      noHuman: 'PO nie napisał jeszcze opisu dla Ciebie — niżej treść z pliku sprintu.', noHumanDraft: 'Sam pomysł. Opis dla Ciebie powstanie, gdy z PO ustalicie, o co chodzi.', noFile: 'Sam temat, jeszcze bez pliku sprintu.',
      close: 'Zamknij', mergedOn: 'Scalony', files: 'Pliki', tokens: 'Tokeny', uat: 'Przegląd', uat_pending: 'czeka na Ciebie', 'uat_n/a': 'nie dotyczy', uat_positive: 'pozytywny', uat_defects: 'z defektami', more: '+{n} więcej', showLess: 'Zwiń', empty: 'pusto',
      sum_backlog: 'Backlog', sum_bugs: 'błędy', sum_major: 'poważne', sum_stale: 'na zamkniętych sprintach', mln: 'mln', fit_in: 'w przedziale', fit_above: 'powyżej', fit_below: 'poniżej',
      enTitle: 'Bez tłumaczenia: tekst z plików po angielsku. Tłumaczenia dochodzą po zapisie zmian przez PO.',
      tr_new: 'Do triażu', tr_now: 'Teraz', tr_sprint: 'W sprincie', tr_touch: 'Przy okazji', tr_later: 'Na później', tr_never: 'Nigdy',
      trh_new: 'nowe, PO jeszcze nie zdecydował', trh_now: 'do zrobienia od razu', trh_sprint: 'przypisane do sprintu', trh_touch: 'zrobi się, gdy sprint dotknie tego miejsca', trh_later: 'czeka na decyzję o sprincie', trh_never: 'świadomie odrzucone',
      sv_blocker: 'Blokujący', sv_major: 'Poważny', sv_minor: 'Drobny', noSev: 'Bez wagi', noSprint: 'Bez sprintu',
      is_new: 'Nowa', is_open: 'Otwarta', is_planned: 'Zaplanowana', is_done: 'Zrobiona', is_dropped: 'Porzucona',
      search: 'Szukaj w tytułach i notatkach…', searchD: 'Szukaj w decyzjach…', anyTriage: 'Triaż: wszystkie', anySev: 'Waga: wszystkie', showClosed: 'Pokaż zamknięte ({n})',
      shownOf: 'Pokazano {a} z {b}', groupBy: 'Grupuj:', g_triage: 'triaż', g_sprint: 'sprint', g_type: 'typ', g_sev: 'waga', showAll: 'Pokaż wszystkie ({n})',
      staleHint: 'Sprint jest już zamknięty, a pozycja nie została rozliczona (ani zrobiona, ani wrócona do triażu).', staleBanner: '{n} otwartych pozycji przypisanych do zamkniętych sprintów:',
      f_note: 'Notatka', f_where: 'Gdzie w kodzie', f_src: 'Źródło', f_status: 'Status', f_state: 'Stan', f_tri: 'Triaż', f_sprint: 'Sprint', f_sev: 'Waga', f_at: 'Dodano', f_est: 'Szacunek', f_alias: 'Alias',
      d_decision: 'Decyzja', d_why: 'Dlaczego', d_rejected: 'Odrzucone', d_at: 'Data', d_by: 'Kto', d_against: 'Wbrew rekomendacji', d_againstOnly: 'Tylko wbrew rekomendacji', allAreas: 'Obszar: wszystkie',
      by_import: 'import (stare dokumenty)', by_po: 'PO z Tobą', no: 'nie',
      r_14: '14 dni', r_30: '30 dni', r_all: 'Wszystko z pomiarem', range: 'Okres:',
      k_sprints: 'Zamknięte sprinty', k_tokens: 'Tokeny razem', k_perFile: 'Koszt na zmieniony plik', k_fit: 'Cena startu trafiona', k_median: 'mediana', k_files: '{n} zmienionych plików', k_fitSub: '{a} powyżej, {b} poniżej', k_noEst: 'brak cen startu',
      c_merged: 'Scalony', c_sprint: 'Sprint', c_kind: 'Rodzaj', c_files: 'Pliki', c_tokens: 'Tokeny', c_perFile: 'Na plik', c_fit: 'Cena startu → wynik', c_review: 'Przegląd',
      ch1: 'Tokeny na sprint', ch1s: 'każdy słupek to jeden scalony sprint, w kolejności scalania', ch2: 'Koszt na zmieniony plik', ch2s: 'mln tokenów na plik; linia przerywana = mediana okresu',
      ch3: 'Cena startu a wynik', ch3s: 'pasek = cena podana na starcie (min–maks), kropka = faktyczny koszt', lg_band: 'cena startu', lg_in: '✓ w przedziale', lg_above: '▲ powyżej', lg_below: '▼ poniżej',
      showTable: 'Pokaż tabelę', hideTable: 'Ukryj tabelę', older: 'Zamknięte bez pomiaru ({n})', median: 'mediana {v}', perFileShort: '{v} / plik', noData: 'Brak zamkniętych sprintów z pomiarem w tym okresie.',
      k_perLine: 'Koszt na zmienioną linię', k_linesOf: 'mediana; linie znane w {n} z {m}', c_lines: 'Linie', c_perLine: 'Na linię (tys.)', ch2l: 'Koszt na zmienioną linię',
      ch2ls: 'tys. tokenów na linię; linia przerywana = mediana okresu', u_file: 'na plik', u_line: 'na linię', perLineShort: '{v} tys. / linię', linesN: 'linii',
      noLines: 'Brak sprintów z liczbą linii w tym okresie.', tys: 'tys.', you_answersList: 'Odpowiedz na pytania:',
      // live sprint view
      lv_live: 'na żywo · {d} temu', lv_live0: 'na żywo', lv_wait: 'czeka na Ciebie · {d}', lv_wait0: 'czeka na Ciebie', lv_stall: 'przestój? · nic nie pracuje od {d}', lv_stall0: 'przestój?',
      lv_hang: 'zawieszenie? · bez postępu od {d}', lv_hang0: 'zawieszenie?', lv_stale: 'brak świeżych danych od {d}', lv_stale0: 'brak świeżych danych', lv_mw: 'czeka na scalenie · {d}', lv_mw0: 'czeka na scalenie',
      lv_stopped: 'zatrzymany', lv_done: 'zakończony', lv_sec: '{n} s', lv_min: '{n} min', lv_h: '{h} h {m} min', lv_ms: '{m} min {s} s', lv_hms: '{h} h {m} min {s} s',
      lv_task: 'Zadanie {k}', lv_taskOf: 'Zadanie {k} z {n}', lv_segs: 'zadania: {d} z {n} gotowe', lv_ofN: '{d} z {n}', lv_commit: 'commit {c}',
      lv_progress: 'Postęp', lv_feed: 'Co się dzieje', lv_all: 'Wszystko', lv_important: 'Tylko ważne', lv_noEvents: 'Brak zdarzeń.',
      lv_tech: 'Szczegóły techniczne przebiegu', lv_run: 'Przebieg', lv_branch: 'Gałąź', lv_tree: 'Katalog roboczy', lv_mode: 'Tryb', lv_byRole: 'Koszt według ról', lv_reason: 'Powód',
      lv_time: 'Czas', lv_start: 'Start', lv_elapsed: 'Trwa', lv_tasksDone: 'Zadania gotowe', lv_eta: 'Koniec (prognoza)', lv_etaAfter: 'po Twojej odpowiedzi', lv_about: 'ok. {t}',
      lv_cost: 'Koszt', lv_spent: 'Zużyte', lv_price: 'Cena startu', lv_priceEst: 'Szacunek', lv_forecast: 'Prognoza z tempa zadań', lv_noPrice: 'bez ceny startu',
      lv_fit_in: '✓ w cenie startu', lv_fit_above: '▲ powyżej ceny startu', lv_fit_below: '▼ poniżej ceny startu',
      lv_youAsk: 'Czekają pytania: {n}, od {d}.', lv_youAsk0: 'Przebieg czeka na Ciebie.', lv_youHow: 'Odpowiedz w rozmowie z PO; praca stoi do odpowiedzi.', lv_youHowTask: 'Odpowiedz w rozmowie z PO; praca nad zadaniem {k} stoi do odpowiedzi.',
      lv_youNow: 'Nic teraz. Następny raz: przegląd po scaleniu.', lv_youNowEta: 'Nic teraz. Następny raz: przegląd po scaleniu (prognoza {t}).',
      lv_youStall: 'Sprawdź, czy PO zareagował na alarm. Jeśli nie, napisz mu: „co ze sprintem {id}?”.', lv_youDone: 'Sprint skończony. Następny krok: przegląd, który poprowadzi PO.', lv_youStopped: 'Przebieg zatrzymany. Zapytaj PO, czy go wznowić.',
      lv_aStall: 'Prawdopodobnie przestój', lv_aHang: 'Proces chyba się zawiesił', lv_aStallTx: 'Nic nie pracuje od {d}; sprint stoi na: {where}. PO dostał alarm.', lv_aStallTx0: 'Nic nie pracuje; sprint stoi na: {where}. PO dostał alarm.',
      lv_aRed: 'Czerwone testy w zadaniu {k}', lv_aRed0: 'Czerwone testy', lv_aRedTx: 'Nie przechodzi {red} z {total} komend testów. Wykonawca poprawia; to zwykły krok, nic od Ciebie.', lv_aRedTx0: 'Część komend testów nie przechodzi. Wykonawca poprawia; to zwykły krok, nic od Ciebie.',
      lv_aStale: 'Strona nie dostaje nowych danych od {d}', lv_aStale0: 'Strona nie dostaje nowych danych', lv_aStaleTx: 'Komputer mógł zasnąć albo proces zapisujący stan się zakończył. Poniżej ostatni znany stan.',
      lv_aStopped: 'Przebieg zatrzymany', lv_aStoppedTx: 'Nic teraz nie pracuje nad tym sprintem.',
      lv_st_done: 'gotowe', lv_st_run: 'w toku', lv_st_wait: 'czeka na Ciebie', lv_st_bad: 'nie przeszło', lv_st_todo: 'do zrobienia',
      'lv_s_plan': 'Plan sprintu', 'lv_s_implement': 'Pisanie kodu', 'lv_s_verify': 'Testy', 'lv_s_review': 'Recenzja', 'lv_s_fix': 'Poprawki', 'lv_s_commit': 'Zapis', 'lv_s_batch': 'Poprawki zbiorcze',
      'lv_s_goal-check': 'Sprawdzenie celu sprintu', 'lv_s_finish': 'Scalenie: pełne testy i połączenie z {target}', 'lv_s_finish0': 'Scalenie: pełne testy i połączenie', 'lv_s_ask': 'Pytanie od wykonawcy', 'lv_s_done': 'Zakończony',
      'lv_n_plan': 'Plan', 'lv_n_goal-check': 'Sprawdzenie celu', 'lv_n_finish': 'Scalenie',
      'lv_o_review-clean': 'recenzja bez uwag', 'lv_o_review-fixed': 'recenzja: uwagi poprawione ({n})', 'lv_o_review-fixed0': 'recenzja: uwagi poprawione', 'lv_o_tests-green': 'komendy testów zielone: {passed}', 'lv_o_tests-green0': 'komendy testów zielone',
      'lv_o_tests-red': '{red} z {total} komend testów nie przechodzi', 'lv_o_tests-red0': 'komendy testów nie przechodzą', 'lv_o_waiting-user': 'czeka na Ciebie', 'lv_o_no-progress': 'brak postępu', 'lv_o_attempt': 'próba {n}', 'lv_o_attempt0': 'kolejna próba',
      'lv_o_plan-ready': 'zadania: {tasks} · pytania: {questions}', 'lv_o_plan-ready0': 'plan gotowy', 'lv_o_deferred': 'drobne uwagi odłożone do końca: {n}', 'lv_o_deferred0': 'drobne uwagi odłożone do końca',
      'lv_w_architect': 'Architekt', 'lv_w_explorer': 'Eksplorator', 'lv_w_executor': 'Wykonawca', 'lv_w_reviewer': 'Recenzent', 'lv_w_checker': 'Sprawdzający', 'lv_w_ui-verifier': 'Weryfikator UI', 'lv_w_script': 'Skrypt', 'lv_w_user': 'Ty',
      'lv_v_read': 'czyta', 'lv_v_edit': 'edytuje', 'lv_v_write': 'zapisuje', 'lv_v_run': 'uruchamia', 'lv_v_search': 'szuka',
      'lv_e_task-start': 'zaczyna zadanie {task}', 'lv_e_task-start0': 'zaczyna zadanie', 'lv_e_tests-green': 'zadanie {task}: komendy testów zielone ({passed})', 'lv_e_tests-green2': 'zadanie {task}: komendy testów zielone', 'lv_e_tests-green0': 'komendy testów zielone',
      'lv_e_tests-red': 'zadanie {task}: {red} z {total} komend testów nie przechodzi', 'lv_e_tests-red1': 'zadanie {task}: komendy testów nie przechodzą ({red})',
      'lv_e_tests-red2': 'zadanie {task}: komendy testów nie przechodzą', 'lv_e_tests-red0': 'komendy testów nie przechodzą', 'lv_e_review-start': 'zaczyna recenzję zadania {task}', 'lv_e_review-start0': 'zaczyna recenzję',
      'lv_e_review-findings': 'zadanie {task}: uwagi do poprawy ({n})', 'lv_e_review-findings0': 'uwagi do poprawy', 'lv_e_task-committed': 'zadanie {task} zapisane (commit {commit})', 'lv_e_task-committed0': 'zadanie zapisane',
      'lv_e_question-waiting': 'pytania do Ciebie ({n}), praca wstrzymana', 'lv_e_question-waiting0': 'pytanie do Ciebie, praca wstrzymana', 'lv_e_answered': 'odpowiedź od Ciebie',
      'lv_e_plan-ready': 'plan gotowy, zadania: {n}', 'lv_e_plan-ready0': 'plan gotowy', 'lv_e_stall': 'przestój: nic nie pracuje', 'lv_e_price-alert': 'koszt przekroczył cenę startu',
      'lv_e_finish-start': 'zaczyna scalanie', 'lv_e_merged': 'sprint scalony',
      'lv_r_plan': 'plan', 'lv_r_exec': 'pisanie', 'lv_r_review': 'recenzja', 'lv_r_orch': 'sterowanie',
      'lv_s_replan': 'Poprawka planu', 'lv_s_continue': 'Dalsza praca nad zadaniem w nowej sesji', 'lv_s_repair': 'Poprawki po pełnych testach',
      'lv_s_handoff': 'Przejście do kolejnego zadania w nowej sesji', 'lv_s_planned': 'Plan gotowy, czeka na scalenie innych sprintów', 'lv_s_stopped': 'Zatrzymany',
      'lv_s_ask-plan': 'Pytania do planu', 'lv_s_ask-rounds': 'Decyzja: rundy recenzji się skończyły', 'lv_s_ask-delete': 'Zgoda na usunięcie plików',
      'lv_e_review-clean': 'zadanie {task}: recenzja bez uwag', 'lv_e_review-clean0': 'recenzja bez uwag', 'lv_e_stopped': 'sprint zatrzymany', 'lv_e_mode-switch': 'przebieg zmienił tryb pracy',
      'lv_e_uat-waiting': 'gotowe do Twojego sprawdzenia', 'lv_e_driver-start': 'start pracy automatycznej', 'lv_e_driver-stop': 'koniec pracy automatycznej', 'lv_e_merge-wait': 'czeka na scalenie',
      'lv_o_review-findings': 'uwagi recenzji do poprawy: {n}', 'lv_o_review-findings0': 'uwagi recenzji do poprawy', 'lv_o_accepted': 'przyjęte mimo uwag recenzji',
      'lv_o_goal-gaps': 'braki względem celu: {n}', 'lv_o_goal-gaps0': 'braki względem celu', 'lv_o_goal-met': 'cel sprintu spełniony', 'lv_o_merge-wait': 'czeka na scalenie',
      'lv_o_finish-conflict': 'konflikt przy scalaniu: potrzebna Twoja decyzja', 'lv_o_finish-red': 'pełne testy nie przechodzą przed scaleniem',
      'lv_o_finish-env': 'kłopot ze środowiskiem testów', 'lv_o_finish-squash-failed': 'scalenie się nie udało',
      'lv_o_finish-deferred-major': 'odłożone poważne uwagi: czekam na Twoją akceptację przed scaleniem',
      lv_planned: 'w kolejce', lv_merged: 'Scalono z {target}', lv_merged0: 'Scalono', lv_plannedTx: 'Plan gotowy, czeka na scalenie: {ids}', lv_plannedTx0: 'Plan gotowy, czeka na scalenie innych sprintów',
      // workplaces (K7, sketch 006 variant C)
      wp_label: 'Miejsce pracy:', wp_all: 'Wszystkie', wp_main: 'Główne drzewo', wp_mainNote: 'sprinty bez miejsca pracy; po przyjęciu scalane do {b} jak dziś', wp_title: 'miejsce pracy {name}',
      wp_st_pushed: 'Wypchnięte · review zespołu', wp_st_attn: 'Czeka na Ciebie', wp_st_running: 'Pracuje', wp_st_ready: 'Gotowe do wypchnięcia', wp_st_waiting: 'Czeka na start',
      wp_branch: 'gałąź', wp_from: 'z', wp_ab: '↑{a} przed', wp_bb: '↓{b} za', wp_abTitle: 'commity na {br}, których nie ma w {base} / commity {base}, których nie ma na {br}', wp_abNone: 'brak gałęzi bazowej {base}',
      wp_pushedL: 'wypchnięte:', wp_pushedYes: '✓ tak, {r}/{br} aktualne', wp_no: 'nie', wp_dirtyL: 'niezapisane:', wp_none: 'brak',
      wp_at: 'stan z {t}', wp_atTitle: 'Fakty z gita z chwili wygenerowania strony; odświeżają się, gdy PO zapisuje zmiany.', wp_seq: 'Po kolei:',
      wp_pushTtl: 'Gotowe do wypchnięcia: gałąź', wp_pushSub: '({c}, nic nie trafiło do {main})', wp_copy: 'Kopiuj', wp_copied: 'Skopiowane',
      wp_after: 'Po wypchnięciu zespół robi review gałęzi. Miejsce pracy sprzątam dopiero na Twoją prośbę, po scaleniu przez zespół.', wp_afterBehind: ' Gałąź jest {c} za {base}; zespół może poprosić o wciągnięcie {base}.',
      wp_a_uat: 'Sprint {id} czeka na Twój UAT.', wp_a_uatTx: 'Co sprawdzić, jest w karcie sprintu. Jego commit już jest na gałęzi {br}; po przyjęciu nic się nie scala do {main}.',
      wp_a_dirty: '{f} niezapisanych w miejscu pracy, spoza sprintów.', wp_a_dirtyHeld: 'Następny sprint ({id}) nie ruszy, dopóki ich nie zapiszesz albo nie odrzucisz. ', wp_a_dirtyIdle: 'Zapisz je albo odrzuć przed wypchnięciem: niezapisane nie pójdą z gałęzią. ', wp_a_files: 'Pliki: ',
      wp_a_behind: '{c} za {base}.', wp_a_behindTx: 'Gałąź wyszła {at}. Przed wypchnięciem warto wciągnąć {base}, inaczej zespół dostanie konflikty przy review.',
      wp_doneWait: 'zrobiony, czeka na wypchnięcie', wp_donePushed: 'wypchnięty, review zespołu', wp_pos: '{k} z {n}',
      wp_box: 'Miejsce pracy', wp_name: 'Nazwa', wp_branchL: 'Gałąź', wp_order: 'Kolejność', wp_first: '(pierwszy)', wp_afterId: '(po {id})', wp_commit: 'Commit',
      wp_note: 'Wynik: jeden commit na gałęzi {br}. Nic nie trafia do {main}; gałąź wypychasz sam.', wp_youClosed: 'Nic przy tym sprincie: jego commit jest na gałęzi {br}. Gałąź wypychasz sam, gdy wszystkie sprinty miejsca pracy są gotowe.',
      wp_spr1: 'sprint', wp_spr2: 'sprinty', wp_spr5: 'sprintów', wp_com1: 'commit', wp_com2: 'commity', wp_com5: 'commitów', wp_file1: 'plik', wp_file2: 'pliki', wp_file5: 'plików',
    },
    en: {
      subtitle: 'Product roadmap', generated: 'Generated', readOnly: 'local file, read-only', productGoal: 'Product goal:',
      roadmap: 'Roadmap', backlog: 'Backlog', decisions: 'Decisions', history: 'History',
      st_draft: 'Draft', st_todo: 'To do', st_inprogress: 'In progress', st_review: 'Awaiting review', st_closed: 'Closed', st_dropped: 'Dropped',
      h_draft: 'an idea; not yet clear what exactly it is', h_todo: 'clear; the PO takes from the top', h_inprogress: 'ordered or running', h_review: 'merged; UAT or code review, then accept',
      k_bugfix: 'Bugfix', k_feature: 'Feature', k_maintenance: 'Maintenance',
      ty_bug: 'Bug', ty_feature: 'Feature', ty_debt: 'Debt', ty_remark: 'Remark', ty_idea: 'Idea', ty_change: 'Change', ty_mockups: 'Mockups',
      nextBadge: 'next', goBadge: 'can go without you', runOrdered: 'waiting to start', runRunning: 'running', afterLbl: 'after', now: 'now',
      need_mockup: 'no mockup', need_price: 'no price', need_answers: 'questions for you', halt_stopped: 'stopped', halt_waiting: 'question for you',
      you_halt_stopped: 'The run has stopped ({r}). Tell the PO whether to resume.', you_halt_waiting: 'The run is waiting for your answer: {r}',
      p_changes: 'What changes', p_not: 'Not included', p_check: 'How to check', p_you: 'From you', p_queue: 'Queue', p_after: 'Must be done first',
      p_scale: 'Scale', p_mockups: 'Mockups', p_decisions: 'Decisions', p_result: 'Result', p_goalFile: 'Goal from the sprint file', p_notes: 'Notes',
      p_tech: 'Technical details (sprint file for agents)', p_items: 'Backlog items', p_touch: 'on touch', p_header: 'Header', p_mode: 'Mode', p_readyAt: 'Ready since', p_run: 'Run',
      you_draft: 'Tell the PO what it is about — still an idea.', you_mockup: 'Mockup to be made.', you_price: 'Price — the PO gives it when taking the sprint.',
      you_answers: 'Answers to questions: {n}.', you_ok: 'Nothing — can go without you.', you_run: 'Nothing. If the run asks, the PO will call you.',
      you_uat: 'Review and accept: steps under "How to check".', you_uatNoSteps: 'Check and accept. The PO gives the steps when you say "let\'s do UAT".', you_closed: 'Nothing — closed.',
      q_pos: '{n}. in "{c}"', q_roadmap: '{n} of {m} in the roadmap', mockPending: 'to be made', est: 'Start price', analog: 'Similar closed', filesN: 'files',
      noHuman: 'The PO has not written a description for you yet — below is the sprint file text.', noHumanDraft: 'Just an idea. The description appears once you and the PO settle what it is about.', noFile: 'Topic only, no sprint file yet.',
      close: 'Close', mergedOn: 'Merged', files: 'Files', tokens: 'Tokens', uat: 'Review', uat_pending: 'waiting for you', 'uat_n/a': 'not applicable', uat_positive: 'passed', uat_defects: 'defects found', more: '+{n} more', showLess: 'Collapse', empty: 'empty',
      sum_backlog: 'Backlog', sum_bugs: 'bugs', sum_major: 'major', sum_stale: 'on closed sprints', mln: 'M', fit_in: 'within', fit_above: 'above', fit_below: 'below',
      enTitle: 'Not translated: English text from the files. Translations arrive after the PO saves changes.',
      tr_new: 'To triage', tr_now: 'Now', tr_sprint: 'In sprint', tr_touch: 'On touch', tr_later: 'Later', tr_never: 'Never',
      trh_new: 'new, the PO has not decided yet', trh_now: 'to do right away', trh_sprint: 'assigned to a sprint', trh_touch: 'done when a sprint touches this place', trh_later: 'waits for a sprint decision', trh_never: 'deliberately rejected',
      sv_blocker: 'Blocker', sv_major: 'Major', sv_minor: 'Minor', noSev: 'No severity', noSprint: 'No sprint',
      is_new: 'New', is_open: 'Open', is_planned: 'Planned', is_done: 'Done', is_dropped: 'Dropped',
      search: 'Search titles and notes…', searchD: 'Search decisions…', anyTriage: 'Triage: all', anySev: 'Severity: all', showClosed: 'Show closed ({n})',
      shownOf: 'Showing {a} of {b}', groupBy: 'Group:', g_triage: 'triage', g_sprint: 'sprint', g_type: 'type', g_sev: 'severity', showAll: 'Show all ({n})',
      staleHint: 'The sprint is closed but the item was neither done nor returned to triage.', staleBanner: '{n} open items are assigned to closed sprints:',
      f_note: 'Note', f_where: 'Where in the code', f_src: 'Source', f_status: 'Status', f_state: 'State', f_tri: 'Triage', f_sprint: 'Sprint', f_sev: 'Severity', f_at: 'Added', f_est: 'Estimate', f_alias: 'Alias',
      d_decision: 'Decision', d_why: 'Why', d_rejected: 'Rejected', d_at: 'Date', d_by: 'By', d_against: 'Against recommendation', d_againstOnly: 'Only against recommendation', allAreas: 'Area: all',
      by_import: 'import (old documents)', by_po: 'PO with you', no: 'no',
      r_14: '14 days', r_30: '30 days', r_all: 'All measured', range: 'Period:',
      k_sprints: 'Sprints closed', k_tokens: 'Tokens total', k_perFile: 'Cost per changed file', k_fit: 'Start price hit', k_median: 'median', k_files: '{n} changed files', k_fitSub: '{a} above, {b} below', k_noEst: 'no start prices',
      c_merged: 'Merged', c_sprint: 'Sprint', c_kind: 'Kind', c_files: 'Files', c_tokens: 'Tokens', c_perFile: 'Per file', c_fit: 'Start price → actual', c_review: 'Review',
      ch1: 'Tokens per sprint', ch1s: 'each column is one merged sprint, in merge order', ch2: 'Cost per changed file', ch2s: 'M tokens per file; dashed line = period median',
      ch3: 'Start price vs actual', ch3s: 'bar = start price (min–max), dot = actual cost', lg_band: 'start price', lg_in: '✓ within', lg_above: '▲ above', lg_below: '▼ below',
      showTable: 'Show table', hideTable: 'Hide table', older: 'Closed without measurement ({n})', median: 'median {v}', perFileShort: '{v} / file', noData: 'No measured closed sprints in this period.',
      k_perLine: 'Cost per changed line', k_linesOf: 'median; lines known for {n} of {m}', c_lines: 'Lines', c_perLine: 'Per line (k)', ch2l: 'Cost per changed line',
      ch2ls: 'thousand tokens per line; dashed line = period median', u_file: 'per file', u_line: 'per line', perLineShort: '{v} k / line', linesN: 'lines',
      noLines: 'No sprints with line counts in this period.', tys: 'k', you_answersList: 'Answer these questions:',
      // live sprint view
      lv_live: 'live · {d} ago', lv_live0: 'live', lv_wait: 'waiting for you · {d}', lv_wait0: 'waiting for you', lv_stall: 'stall? · nothing working for {d}', lv_stall0: 'stall?',
      lv_hang: 'hung? · no progress for {d}', lv_hang0: 'hung?', lv_stale: 'no fresh data for {d}', lv_stale0: 'no fresh data', lv_mw: 'waiting to merge · {d}', lv_mw0: 'waiting to merge',
      lv_stopped: 'stopped', lv_done: 'finished', lv_sec: '{n} s', lv_min: '{n} min', lv_h: '{h} h {m} min', lv_ms: '{m} min {s} s', lv_hms: '{h} h {m} min {s} s',
      lv_task: 'Task {k}', lv_taskOf: 'Task {k} of {n}', lv_segs: 'tasks: {d} of {n} done', lv_ofN: '{d} of {n}', lv_commit: 'commit {c}',
      lv_progress: 'Progress', lv_feed: "What's happening", lv_all: 'All', lv_important: 'Important', lv_noEvents: 'No events yet.',
      lv_tech: 'Run technical details', lv_run: 'Run', lv_branch: 'Branch', lv_tree: 'Worktree', lv_mode: 'Mode', lv_byRole: 'Cost by role', lv_reason: 'Reason',
      lv_time: 'Time', lv_start: 'Start', lv_elapsed: 'Elapsed', lv_tasksDone: 'Tasks done', lv_eta: 'End (forecast)', lv_etaAfter: 'after your answer', lv_about: 'about {t}',
      lv_cost: 'Cost', lv_spent: 'Spent', lv_price: 'Start price', lv_priceEst: 'Estimate', lv_forecast: 'Forecast from task pace', lv_noPrice: 'no start price',
      lv_fit_in: '✓ within the start price', lv_fit_above: '▲ above the start price', lv_fit_below: '▼ below the start price',
      lv_youAsk: '{n} question(s) waiting for {d}.', lv_youAsk0: 'The run is waiting for you.', lv_youHow: 'Answer in the conversation with the PO; work is paused until then.', lv_youHowTask: 'Answer in the conversation with the PO; work on task {k} is paused until then.',
      lv_youNow: 'Nothing now. Next time: the review after the merge.', lv_youNowEta: 'Nothing now. Next time: the review after the merge (forecast {t}).',
      lv_youStall: 'Check whether the PO reacted to the alarm. If not, write to them: “what about sprint {id}?”.', lv_youDone: 'The sprint is finished. Next step: the review, led by the PO.', lv_youStopped: 'The run is stopped. Ask the PO whether to resume it.',
      lv_aStall: 'Probably a stall', lv_aHang: 'The process seems to hang', lv_aStallTx: 'Nothing has been working for {d}; the sprint stands at: {where}. The PO got an alarm.', lv_aStallTx0: 'Nothing is working; the sprint stands at: {where}. The PO got an alarm.',
      lv_aRed: 'Red tests in task {k}', lv_aRed0: 'Red tests', lv_aRedTx: '{red} of {total} test commands fail. The executor is fixing them; a normal step, nothing needed from you.', lv_aRedTx0: 'Some test commands fail. The executor is fixing them; a normal step, nothing needed from you.',
      lv_aStale: 'The page has had no new data for {d}', lv_aStale0: 'The page gets no new data', lv_aStaleTx: 'The computer may have gone to sleep or the process writing the state has ended. Below: the last known state.',
      lv_aStopped: 'Run stopped', lv_aStoppedTx: 'Nothing is working on this sprint now.',
      lv_st_done: 'done', lv_st_run: 'in progress', lv_st_wait: 'waiting for you', lv_st_bad: 'failed', lv_st_todo: 'to do',
      'lv_s_plan': 'Sprint plan', 'lv_s_implement': 'Writing code', 'lv_s_verify': 'Tests', 'lv_s_review': 'Review', 'lv_s_fix': 'Fixes', 'lv_s_commit': 'Commit', 'lv_s_batch': 'Batch fixes',
      'lv_s_goal-check': 'Sprint goal check', 'lv_s_finish': 'Merge: full tests and merge into {target}', 'lv_s_finish0': 'Merge: full tests and merge', 'lv_s_ask': 'A question from the executor', 'lv_s_done': 'Finished',
      'lv_n_plan': 'Plan', 'lv_n_goal-check': 'Goal check', 'lv_n_finish': 'Merge',
      'lv_o_review-clean': 'review clean', 'lv_o_review-fixed': 'review: findings fixed ({n})', 'lv_o_review-fixed0': 'review: findings fixed', 'lv_o_tests-green': 'test commands green: {passed}', 'lv_o_tests-green0': 'test commands green',
      'lv_o_tests-red': '{red} of {total} test commands fail', 'lv_o_tests-red0': 'test commands fail', 'lv_o_waiting-user': 'waiting for you', 'lv_o_no-progress': 'no progress', 'lv_o_attempt': 'attempt {n}', 'lv_o_attempt0': 'another attempt',
      'lv_o_plan-ready': 'tasks: {tasks} · questions: {questions}', 'lv_o_plan-ready0': 'plan ready', 'lv_o_deferred': 'small findings deferred to the end: {n}', 'lv_o_deferred0': 'small findings deferred to the end',
      'lv_w_architect': 'Architect', 'lv_w_explorer': 'Explorer', 'lv_w_executor': 'Executor', 'lv_w_reviewer': 'Reviewer', 'lv_w_checker': 'Checker', 'lv_w_ui-verifier': 'UI verifier', 'lv_w_script': 'Script', 'lv_w_user': 'You',
      'lv_v_read': 'reads', 'lv_v_edit': 'edits', 'lv_v_write': 'writes', 'lv_v_run': 'runs', 'lv_v_search': 'searches',
      'lv_e_task-start': 'starts task {task}', 'lv_e_task-start0': 'starts a task', 'lv_e_tests-green': 'task {task}: test commands green ({passed})', 'lv_e_tests-green2': 'task {task}: test commands green', 'lv_e_tests-green0': 'test commands green',
      'lv_e_tests-red': 'task {task}: {red} of {total} test commands fail', 'lv_e_tests-red1': 'task {task}: test commands fail ({red})',
      'lv_e_tests-red2': 'task {task}: test commands fail', 'lv_e_tests-red0': 'test commands fail', 'lv_e_review-start': 'starts reviewing task {task}', 'lv_e_review-start0': 'starts a review',
      'lv_e_review-findings': 'task {task}: findings to fix ({n})', 'lv_e_review-findings0': 'findings to fix', 'lv_e_task-committed': 'task {task} committed ({commit})', 'lv_e_task-committed0': 'task committed',
      'lv_e_question-waiting': 'questions for you ({n}), work paused', 'lv_e_question-waiting0': 'a question for you, work paused', 'lv_e_answered': 'your answer arrived',
      'lv_e_plan-ready': 'plan ready, tasks: {n}', 'lv_e_plan-ready0': 'plan ready', 'lv_e_stall': 'stall: nothing is working', 'lv_e_price-alert': 'cost passed the start price',
      'lv_e_finish-start': 'starts the merge', 'lv_e_merged': 'sprint merged',
      'lv_r_plan': 'plan', 'lv_r_exec': 'writing', 'lv_r_review': 'review', 'lv_r_orch': 'orchestration',
      'lv_s_replan': 'Plan correction', 'lv_s_continue': 'Continuing the task in a fresh session', 'lv_s_repair': 'Fixing after the full test run',
      'lv_s_handoff': 'Moving on to the next task in a new session', 'lv_s_planned': 'Plan ready, waiting for other sprints to merge', 'lv_s_stopped': 'Stopped',
      'lv_s_ask-plan': 'Questions about the plan', 'lv_s_ask-rounds': 'A decision: review rounds used up', 'lv_s_ask-delete': 'Consent to delete files',
      'lv_e_review-clean': 'task {task}: review clean', 'lv_e_review-clean0': 'review clean', 'lv_e_stopped': 'sprint stopped', 'lv_e_mode-switch': 'the run switched its working mode',
      'lv_e_uat-waiting': 'ready for your check', 'lv_e_driver-start': 'automatic work started', 'lv_e_driver-stop': 'automatic work ended', 'lv_e_merge-wait': 'waiting to merge',
      'lv_o_review-findings': 'review findings to fix: {n}', 'lv_o_review-findings0': 'review findings to fix', 'lv_o_accepted': 'accepted despite review findings',
      'lv_o_goal-gaps': 'gaps against the goal: {n}', 'lv_o_goal-gaps0': 'gaps against the goal', 'lv_o_goal-met': 'sprint goal met', 'lv_o_merge-wait': 'waiting to merge',
      'lv_o_finish-conflict': 'merge conflict: your decision needed', 'lv_o_finish-red': 'the full test run fails before the merge',
      'lv_o_finish-env': 'a problem with the test environment', 'lv_o_finish-squash-failed': 'the merge did not succeed',
      'lv_o_finish-deferred-major': 'deferred major findings: waiting for your acceptance before the merge',
      lv_planned: 'queued', lv_merged: 'Merged into {target}', lv_merged0: 'Merged', lv_plannedTx: 'Plan ready, waiting for the merge of: {ids}', lv_plannedTx0: 'Plan ready, waiting for other sprints to merge',
      // workplaces (K7, sketch 006 variant C)
      wp_label: 'Workplace:', wp_all: 'All', wp_main: 'Main tree', wp_mainNote: 'sprints without a workplace; merged into {b} after acceptance, as today', wp_title: 'workplace {name}',
      wp_st_pushed: 'Pushed · team review', wp_st_attn: 'Waiting for you', wp_st_running: 'Working', wp_st_ready: 'Ready to push', wp_st_waiting: 'Waiting to start',
      wp_branch: 'branch', wp_from: 'from', wp_ab: '↑{a} ahead', wp_bb: '↓{b} behind', wp_abTitle: 'commits on {br} missing in {base} / commits of {base} missing on {br}', wp_abNone: 'base branch {base} not found',
      wp_pushedL: 'pushed:', wp_pushedYes: '✓ yes, {r}/{br} up to date', wp_no: 'no', wp_dirtyL: 'uncommitted:', wp_none: 'none',
      wp_at: 'as of {t}', wp_atTitle: 'Git facts from when the page was generated; they refresh when the PO saves changes.', wp_seq: 'In order:',
      wp_pushTtl: 'Ready to push: branch', wp_pushSub: '({c}, nothing went into {main})', wp_copy: 'Copy', wp_copied: 'Copied',
      wp_after: 'After the push the team reviews the branch. I clean up the workplace only when you ask, after the team has merged it.', wp_afterBehind: ' The branch is {c} behind {base}; the team may ask you to merge {base} in.',
      wp_a_uat: 'Sprint {id} is waiting for your UAT.', wp_a_uatTx: 'What to check is on the sprint card. Its commit is on branch {br} already; accepting it merges nothing into {main}.',
      wp_a_dirty: '{f} uncommitted in the workplace, from outside the sprints.', wp_a_dirtyHeld: 'The next sprint ({id}) will not start until you commit or discard them. ', wp_a_dirtyIdle: 'Commit or discard them before pushing: uncommitted files do not go with the branch. ', wp_a_files: 'Files: ',
      wp_a_behind: '{c} behind {base}.', wp_a_behindTx: 'The branch started on {at}. Merge {base} in before pushing, or the team gets conflicts in the review.',
      wp_doneWait: 'done, waiting for the push', wp_donePushed: 'pushed, team review', wp_pos: '{k} of {n}',
      wp_box: 'Workplace', wp_name: 'Name', wp_branchL: 'Branch', wp_order: 'Order', wp_first: '(first)', wp_afterId: '(after {id})', wp_commit: 'Commit',
      wp_note: 'Result: one commit on branch {br}. Nothing goes into {main}; you push the branch yourself.', wp_youClosed: 'Nothing for this sprint: its commit is on branch {br}. You push the branch yourself once all sprints of the workplace are done.',
      wp_spr1: 'sprint', wp_spr2: 'sprints', wp_spr5: 'sprints', wp_com1: 'commit', wp_com2: 'commits', wp_com5: 'commits', wp_file1: 'file', wp_file2: 'files', wp_file5: 'files',
    },
  };
  const ui = () => (LANG === 'pl' ? 'pl' : 'en');
  const t = (k, vars) => {
    let s = T[ui()][k] != null ? T[ui()][k] : T.en[k] != null ? T.en[k] : k;
    if (vars) for (const [a, b] of Object.entries(vars)) s = s.split('{' + a + '}').join(String(b));
    return s;
  };
  const locale = () => (LANG === 'en' ? 'en-GB' : LANG);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const nf = (x, d) => { try { return new Intl.NumberFormat(locale(), { maximumFractionDigits: d }).format(x); } catch (e) { return String(x); } };
  const fmtN = (x) => (x == null ? '—' : nf(x, 2));
  const fmtM = (x) => (x == null ? '—' : nf(x, x < 10 ? 2 : 1) + ' ' + t('mln'));
  const fmtK = (x) => (x == null ? '—' : nf(x, x < 10 ? 2 : 1) + ' ' + t('tys'));
  const fmtRange = (r) => (r ? fmtN(r[0]) + '–' + fmtM(r[1]) : '—');
  const fmtDate = (s) => { if (!s || !/^\d{4}-\d\d-\d\d/.test(s)) return s || '—'; try { return new Intl.DateTimeFormat(locale(), { day: 'numeric', month: 'short' }).format(new Date(s.slice(0, 10) + 'T12:00')); } catch (e) { return s; } };
  const fmtStamp = (s) => { try { return new Intl.DateTimeFormat(locale(), { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(s)); } catch (e) { return s; } };
  const TODAY = new Date(String(D.generatedAt).slice(0, 10) + 'T12:00');
  const daysAgo = (s) => Math.round((TODAY - new Date(s + 'T12:00')) / 864e5);

  // Content: translations from the memory in the content language, English source in EN mode.
  const trOn = () => LANG !== 'en' && LANG === CL;
  const tx = (src, tr) => (trOn() && tr ? tr : src);
  const untr = (src, tr) => trOn() && !!src && !tr;
  const EN = () => `<span class="en-badge" title="${esc(t('enTitle'))}">EN</span>`;
  const enIf = (c) => (c ? EN() : '');

  // ---------- model ----------
  const S = Object.fromEntries(D.sprints.map((s) => [s.id, s]));
  const OPEN = D.sprints.filter((s) => s.open);
  const ITEMS = Object.fromEntries(D.items.map((x) => [x.id, x]));
  const DECS = Object.fromEntries(D.decisions.map((x) => [x.id, x]));
  const OPEN_ITEMS = D.items.filter((x) => !x.closed);
  const COLS = ['draft', 'todo', 'inprogress', 'review'];
  const cols = Object.fromEntries(COLS.map((c) => [c, []]));
  OPEN.forEach((s) => { if (cols[s.human]) cols[s.human].push(s); });
  const reviewArch = D.sprints.filter((s) => !s.open && s.human === 'review').sort((a, b) => String(b.merged || '').localeCompare(String(a.merged || '')));
  const staleN = Object.values(D.stale || {}).reduce((a, x) => a + x.length, 0);
  const stateOf = (s) => s.human || (s.dropped ? 'dropped' : 'closed');
  const sTitle = (s) => (LANG !== 'en' && s.forYou ? s.forYou.title : tx(s.goal, s.goalTr));
  const sUntr = (s) => !(LANG !== 'en' && s.forYou) && untr(s.goal, s.goalTr);

  // ---------- small renderers ----------
  const pill = (st, label) => `<span class="pill ${esc(st)}">${esc(label || t('st_' + st))}</span>`;
  const KL = { bugfix: 'B', bug: 'B', fix: 'B', feature: 'F', maintenance: 'M', debt: 'D', remark: 'R', idea: 'I', change: 'C', mockups: 'U' };
  const kind = (k, item) => (k ? `<span class="kind ${esc(k)}" title="${esc(t((item ? 'ty_' : 'k_') + k))}">${KL[k] || '?'}</span>` : '');
  const sevPill = (s) => (s ? `<span class="pill sev-${esc(s)}">${esc(t('sv_' + s))}</span>` : '');
  const LOCK = '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M4 7V5a4 4 0 0 1 8 0v2h1v8H3V7h1zm2 0h4V5a2 2 0 0 0-4 0v2z"/></svg>';
  const chip = (id) => (S[id] ? `<span class="chip" data-open="${esc(id)}" title="${esc(sTitle(S[id]))}">${esc(id)}</span>` : `<span class="id">${esc(id)}</span>`);
  const afterChip = (id, label) => `<span class="after-chip" data-open="${esc(id)}" title="${esc(S[id] ? sTitle(S[id]) : id)}">${LOCK}${label ? esc(t('afterLbl')) + ': ' : ''}${esc(id)}</span>`;
  const refTitle = (id) => (ITEMS[id] ? ITEMS[id].title : DECS[id] ? DECS[id].title : '');
  const inline = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\b(PD-\d+|B-\d+)\b/g, (m) => `<span class="ref" title="${esc(refTitle(m))}">${m}</span>`);
  const textBlock = (txt) => {
    const out = []; let list = null;
    for (const line of String(txt || '').split('\n')) {
      if (/^\s*[-*] /.test(line)) { if (!list) { list = []; out.push(list); } list.push(line.replace(/^\s*[-*] /, '')); }
      else if (line.trim()) { list = null; out.push(line); }
    }
    return out.map((b) => (Array.isArray(b) ? '<ul>' + b.map((l) => `<li>${inline(l)}</li>`).join('') + '</ul>' : `<p>${inline(b)}</p>`)).join('');
  };
  const hlist = (arr, cls) => `<ul class="hp-list ${cls}">${arr.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`;
  const fitOf = (tok, rg) => (!rg || tok == null ? null : tok > rg[1] ? 'above' : tok < rg[0] ? 'below' : 'in');
  const FIT_IC = { in: '✓', above: '▲', below: '▼' };
  const fitHtml = (f) => (f ? `<span class="fit ${f}"><span class="ic">${FIT_IC[f]}</span>${esc(t('fit_' + f))}</span>` : '<span class="subtle">—</span>');

  // ---------- live sprint view ----------
  // While a sprint runs, a writer process keeps `live.js` next to this page (`window.__dwmtLive`, contract v1). The page
  // re-injects it as a classic script every `intervalSec` (file:// allows that; no network APIs, no modules), pauses while
  // the tab is hidden, and re-renders only the live parts in place. Missing or partial fields degrade to less UI.
  const LIVE = D.live || {};
  const LV = { snap: null, by: {}, synth: {}, seq: 0, timer: null, fail: 0, stale: false, sig: '', top: {}, flash: {}, all: store.get('feed') !== 'ms', modal: null };
  const ACTIVE = ['work', 'waiting-user', 'stall', 'hang', 'merge-wait'];
  const OVER = ['done', 'stopped'];
  const arr = (x) => (Array.isArray(x) ? x.filter((y) => y && typeof y === 'object' || typeof y === 'string') : []);
  const numv = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
  const ts = (s) => { const x = s ? Date.parse(s) : NaN; return Number.isFinite(x) ? x : null; };
  const hum = (k) => { const s = String(k == null ? '' : k).replace(/[-_]+/g, ' ').trim(); return s ? s[0].toUpperCase() + s.slice(1) : ''; };
  // Template with params: the first of `<key>`, `<key>1`, `<key>2`, `<key>0` whose params are all given (fewer params,
  // shorter text; `0` has none); unknown key → null.
  const tv = (k, p) => {
    const val = (a) => (p && p[a] != null && p[a] !== '' ? (typeof p[a] === 'number' ? nf(p[a], 2) : String(p[a])) : null);
    const str = (x) => (T[ui()][x] != null ? T[ui()][x] : T.en[x] != null ? T.en[x] : null);
    const all = [k, k + '1', k + '2', k + '0'].map(str).filter((x) => x != null);
    if (str(k) == null || !all.length) return null;
    const s = all.find((x) => (x.match(/\{\w+\}/g) || []).every((m) => val(m.slice(1, -1)) != null)) || all[0];
    return s.replace(/\{(\w+)\}/g, (m, a) => (val(a) == null ? '?' : val(a)));
  };
  const lbl = (pre, k, p) => (k == null || k === '' ? '' : tv(pre + k, p) || hum(k));
  const stepLbl = (k) => tv('lv_n_' + k) || lbl('lv_s_', k);
  const noteTxt = (n) => (n && typeof n === 'object' && n.key ? lbl('lv_o_', n.key, n) : '');
  const dur = (sec) => { if (sec == null || !Number.isFinite(sec)) return null; const s = Math.max(0, Math.round(sec)); if (s < 60) return t('lv_sec', { n: s }); const m = Math.floor(s / 60); return m < 60 ? t('lv_min', { n: m }) : t('lv_h', { h: Math.floor(m / 60), m: m % 60 }); };
  const durS = (sec) => { const s = Math.max(0, Math.floor(sec)), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = String(s % 60).padStart(2, '0'); return h ? t('lv_hms', { h, m: String(m).padStart(2, '0'), s: x }) : t('lv_ms', { m, s: x }); };
  const since = (ms, now) => (ms == null ? null : dur((now - ms) / 1000));
  // Texts that change with the clock sit in `.lv-t` spans: a part whose markup differs only there keeps its DOM (text
  // selection, focus) and gets new text; any other change replaces the part's HTML. The markup signature (a hash without
  // the clock texts) rides on the element (`data-lv-h` from the first render, then a property).
  const tm = (s) => `<span class="lv-t">${esc(s)}</span>`;
  const TM = /<span class="lv-t">([^<]*)<\/span>/g;
  const unesc = (s) => s.replace(/&(amp|lt|gt|quot|#39);/g, (m, x) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" }[x]));
  const sigOf = (html) => { const x = html.replace(TM, '<span class="lv-t"></span>'); let h = 5381; for (let i = 0; i < x.length; i++) h = ((h * 33) ^ x.charCodeAt(i)) >>> 0; return `${h.toString(36)}.${x.length}`; };
  function put(el, html) {
    const sig = sigOf(html), had = el._lvSig != null ? el._lvSig : el.getAttribute ? el.getAttribute('data-lv-h') : null;
    if (had !== sig) { el.innerHTML = html; el._lvSig = sig; return; }
    const texts = [...html.matchAll(TM)].map((m) => unesc(m[1]));
    el.querySelectorAll('.lv-t').forEach((x, i) => { if (texts[i] != null && x.textContent !== texts[i]) x.textContent = texts[i]; });
  }
  const clock = (ms) => { try { const d = new Date(ms), same = new Date().toDateString() === d.toDateString(); return new Intl.DateTimeFormat(locale(), same ? { hour: '2-digit', minute: '2-digit' } : { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(d); } catch (e) { return ''; } };
  const hms = (s) => { const x = ts(s); if (x == null) return ''; try { return new Intl.DateTimeFormat(locale(), { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(x)); } catch (e) { return ''; } };
  const ivl = () => Math.max(1, numv(LV.snap && LV.snap.intervalSec) || numv(LIVE.intervalSec) || 5);
  // Stale: no fresh snapshot for max(3 × interval, 20 s) while a live writer reports work; an ended writer never goes stale.
  const isStale = (now) => { const sn = LV.snap; if (!sn || sn.writer === 'ended') return false; const w = ts(sn.writtenAt); return arr(sn.runs).some((r) => r.status === 'work') && (w == null || now - w > Math.max(3 * ivl(), 20) * 1000); };
  // Status shown for a run: stale data wins; an ended writer that left a run in work is stale too.
  const shownOf = (r) => (LV.stale || (LV.snap && LV.snap.writer === 'ended' && r.status === 'work') ? 'stale' : r.status || 'work');
  const sprintById = (id) => S[id] || LV.synth[id];
  const runOf = (id) => (LV.by && LV.by[id]) || null;
  // A live run whose sprint is not in "In progress" on this page (generated before the start) moves there.
  const lvMoved = (s) => { const r = runOf(s.id); return !!r && ACTIVE.includes(r.status) && s.human !== 'inprogress'; };
  const rank = (r) => (ACTIVE.includes(r.status) ? 1e13 : 0) + (ts(r.startedAt) || 0);
  const synthSprint = (id, r) => ({ id, synthetic: true, open: true, human: 'inprogress', state: 'running', goal: r.goal || id, goalTr: null, kind: null, after: [], afterOpen: [], needs: [],
    mockups: [], decisions: [], items: [], touch: [], sections: [], forYou: null, fallback: null, hasFile: false, ui: false, current: false });
  // Runs → sprint cards: by roadmap sprint id, else by the run id in a sprint header, else a card of its own.
  function lvIndex() {
    const by = {}, synth = {}, gen = ts(D.generatedAt) || 0, w = ts(LV.snap.writtenAt) || 0;
    for (const r of arr(LV.snap.runs)) {
      if (typeof r !== 'object') continue;
      if ((r.status === 'done' || r.status === 'stopped') && w < gen) continue; // the page is newer than the run's end
      let id = r.sprint && S[r.sprint] ? r.sprint : ((r.run && D.sprints.find((s) => s.run === r.run)) || {}).id;
      if (!id) { id = String(r.sprint || r.run || 'run'); synth[id] = synthSprint(id, r); }
      if (!by[id] || rank(r) > rank(by[id])) by[id] = r;
    }
    LV.by = by; LV.synth = synth;
  }
  const boardSig = () => Object.keys(LV.by).sort().map((id) => id + (sprintById(id) && lvMoved(sprintById(id)) ? '>' : '')).join(',');

  function indState(r, now) {
    const s = shownOf(r), sn = ts(r.since);
    const d = (k, ms) => tv(k, { d: since(ms, now) });
    if (s === 'stale') return ['stale', d('lv_stale', ts(LV.snap.writtenAt))];
    if (s === 'waiting-user') return ['wait', d('lv_wait', sn)];
    if (s === 'stall') return ['stall', d('lv_stall', sn)];
    if (s === 'hang') return ['stall', d('lv_hang', sn)];
    if (s === 'merge-wait') return ['mw', d('lv_mw', sn)];
    if (s === 'stopped') return ['stopped', t('lv_stopped')];
    if (s === 'planned') return ['mw', t('lv_planned')];
    if (s === 'done') return ['done', t('lv_done')];
    return ['work', d('lv_live', ts(LV.snap.writtenAt))];
  }
  const ind = (r, now) => { const [c, l] = indState(r, now); return `<span class="live ${c}"><i></i>${tm(l)}</span>`; };
  const waitIds = (r) => arr(r.waitingFor).filter((x) => typeof x === 'string').join(', ');
  const tasksOf = (r) => arr(r.tasks).map((x, i) => ({ ...x, k: x.k != null ? x.k : i + 1 }));
  const curTask = (r) => tasksOf(r).find((x) => x.state === 'run' || x.state === 'wait') || null;
  // Where the run stands (the indicator next to it says the status, e.g. "waiting for you · 3 min": not repeated here).
  function nowLine(r) {
    if (r.status === 'planned') return tv('lv_plannedTx', { ids: waitIds(r) });
    if (r.status === 'done') return tv('lv_merged', { target: typeof r.target === 'string' ? r.target : null });
    const st = r.step && typeof r.step === 'object' ? r.step : {}, n = arr(r.tasks).length;
    const key = r.status === 'done' ? 'done' : st.key;
    const task = st.task != null && r.status !== 'done' ? (n ? t('lv_taskOf', { k: st.task, n }) : t('lv_task', { k: st.task })) : '';
    const fb = { 'waiting-user': 'lv_wait0', stall: 'lv_stall0', hang: 'lv_hang0', 'merge-wait': 'lv_mw0', stopped: 'lv_stopped', done: 'lv_done' }[r.status] || 'lv_live0';
    return [task, key ? stepLbl(key) : ''].filter(Boolean).join(' · ') || t(fb);
  }
  const price = (c) => (Array.isArray(c.priceM) && c.priceM.length === 2 && c.priceM.every((x) => numv(x) != null) ? c.priceM : null);
  function lvCard(r, now) {
    const tasks = tasksOf(r), done = tasks.filter((x) => x.state === 'done').length, c = r.cost && typeof r.cost === 'object' ? r.cost : {}, pr = price(c);
    const SEG = { done: 'done', run: 'run', wait: 'wait' };
    const segs = tasks.length ? `<div class="segs" role="img" aria-label="${esc(t('lv_segs', { d: done, n: tasks.length }))}">${tasks.map((x) => `<span class="${SEG[x.state] || ''}"></span>`).join('')}</div>` : '';
    const money = numv(c.spentM) != null ? `${nf(c.spentM, 1)}${pr ? ` / ${nf(pr[0], 1)}–${nf(pr[1], 1)}` : ''} ${t('mln')}` : '';
    return `${segs}<div class="now"><span>${esc(nowLine(r))}</span><span class="num">${esc(money)}</span></div><div class="foot lv-foot">${ind(r, now)}</div>`;
  }

  // Sprint card parts (re-rendered in place on every poll and every second; the feed only on a new snapshot).
  const box = (cls, title, text) => `<div class="alert ${cls}"><b>${tm(title)}</b>${tm(text)}</div>`;
  function redOf(r) {
    const x = curTask(r);
    if (!x) return null;
    const s = arr(x.steps).find((y) => (y.note && y.note.key === 'tests-red') || (y.key === 'verify' && y.state === 'bad'));
    return s ? { k: x.k, red: s.note && s.note.red, total: s.note && s.note.total } : null;
  }
  function alertHtml(r, now) {
    const s = shownOf(r);
    if (s === 'stale') return box('mute', tv('lv_aStale', { d: since(ts(LV.snap.writtenAt), now) }), t('lv_aStaleTx'));
    if (s === 'stall' || s === 'hang') return box('bad', t(s === 'hang' ? 'lv_aHang' : 'lv_aStall'), tv('lv_aStallTx', { d: since(ts(r.since), now), where: nowLine(r) }));
    if (s === 'stopped') return box('mute', t('lv_aStopped'), t('lv_aStoppedTx'));
    const red = s === 'work' ? redOf(r) : null;
    return red ? box('info', tv('lv_aRed', { k: red.k }), tv('lv_aRedTx', red)) : '';
  }
  const IC = { done: '✓', run: '●', wait: '!', bad: '✗', todo: '' };
  const stOf = (x) => (IC[x.state] != null ? x.state : 'todo');
  function stepRow(name, x, now, extra) {
    const st = stOf(x), cur = st === 'run' || st === 'wait', a = ts(x.startedAt), b = ts(x.endedAt);
    const sec = a != null && (b != null || cur) ? ((b != null ? b : now) - a) / 1000 : null;
    const meta = st === 'todo' ? '' : [dur(sec), numv(x.costM) != null ? fmtM(x.costM) : ''].filter(Boolean).join(' · ');
    const note = [noteTxt(x.note), x.commit ? t('lv_commit', { c: x.commit }) : ''].filter(Boolean).join(' · ');
    return `<li class="${st === 'todo' ? 'todo' : ''}${cur ? ' cur' : ''}${st === 'wait' ? ' waiting' : ''}"><span class="st-ic ${st}" role="img" aria-label="${esc(t('lv_st_' + st))}">${IC[st]}</span>
      <span class="st-name">${name}</span><span class="st-meta">${tm(meta)}</span>${note ? `<span class="st-note">${esc(note)}</span>` : ''}${extra || ''}</li>`;
  }
  const subHtml = (steps) => (steps.length ? `<div class="sub">${steps.map((x) => {
    const st = stOf(x), d = noteTxt(x.note) || (st === 'done' && numv(x.min) != null ? dur(x.min * 60) : '');
    return `<span class="${st}">${IC[st] ? IC[st] + ' ' : ''}${esc(lbl('lv_s_', x.key))}${d ? ' · ' + esc(d) : ''}</span>`;
  }).join('')}</div>` : '');
  function progHtml(r, now) {
    let untrN = false;
    const rows = [...arr(r.pre).map((x) => stepRow(esc(lbl('lv_s_', x.key)), x, now)),
      ...tasksOf(r).map((x) => {
        const title = trOn() && x.titleTr ? x.titleTr : x.title || '';
        if (untr(x.title, x.titleTr)) untrN = true;
        const cur = x.state === 'run' || x.state === 'wait';
        return stepRow(`<span class="subtle">${esc(t('lv_task', { k: x.k }))}${title ? ' · ' : ''}</span>${esc(title)}`, x, now, cur ? subHtml(arr(x.steps)) : '');
      }),
      ...arr(r.post).map((x) => stepRow(esc(lbl('lv_s_', x.key, { target: typeof r.target === 'string' ? r.target : null })), x, now))];
    return rows.length ? `<div class="hp-sec"><h3>${esc(t('lv_progress'))}${enIf(untrN)}</h3><ol class="steps">${rows.join('')}</ol></div>` : '';
  }
  const fkey = (x) => [x.at, x.who, x.kind, x.key, x.text].join('|');
  function feedRow(x, isNew) {
    const ev = x.kind === 'event' || (!x.kind && !!x.key);
    const p = { ...(x.params && typeof x.params === 'object' ? x.params : {}) };
    if (p.n == null && p.tasks != null) p.n = p.tasks;
    const what = ev ? lbl('lv_e_', x.key, p) : lbl('lv_v_', x.kind);
    return `<li class="${x.important ? 'ms' : ''}${isNew ? ' new' : ''}"><span class="tm">${esc(hms(x.at))}</span><span><span class="who">${esc(lbl('lv_w_', x.who))}</span> <span class="what">${esc(what)}</span>${!ev && x.text ? `<div class="obj">${esc(x.text)}</div>` : ''}</span></li>`;
  }
  function feedHtml(id, r) {
    if (r.feed == null) return ''; // a mode without activity data: no feed section
    const rows = arr(r.feed).filter((x) => LV.all || x.important).slice(0, 10), fl = LV.flash[id];
    const tog = `<span class="seg" role="group" aria-label="${esc(t('lv_feed'))}">${[['all', 'lv_all', LV.all], ['ms', 'lv_important', !LV.all]].map(([k, l, on]) => `<button type="button" data-feed="${k}" class="${on ? 'on' : ''}" aria-pressed="${on}">${esc(t(l))}</button>`).join('')}</span>`;
    return `<div class="hp-sec"><div class="feed-head"><h3>${esc(t('lv_feed'))}</h3>${tog}</div>${rows.length ? `<ul class="feed">${rows.map((x, i) => feedRow(x, i === 0 && !!fl && fl === fkey(x))).join('')}</ul>` : `<div class="feed-empty">${esc(t('lv_noEvents'))}</div>`}</div>`;
  }
  function techHtml(r) {
    const c = r.cost && typeof r.cost === 'object' ? r.cost : {};
    const roles = c.byRole && typeof c.byRole === 'object' ? Object.entries(c.byRole).filter(([, v]) => numv(v) != null).map(([k, v]) => `${tv('lv_r_' + k) || k} ${nf(v, 2)}`) : [];
    const kv = [['lv_run', r.run], ['lv_branch', r.branch], ['lv_tree', r.tree], ['lv_mode', r.mode], ['lv_byRole', roles.length ? `${roles.join(' · ')} ${t('mln')}` : ''], ['lv_reason', r.reason]].filter((x) => x[1]);
    return `<div class="dsec"><dl class="kv2">${kv.map(([k, v]) => `<dt>${esc(t(k))}</dt><dd>${esc(v)}</dd>`).join('')}</dl></div>`;
  }
  function youHtml(s, r, now, cls) {
    let body, kind = 'ok';
    if (r.status === 'waiting-user') {
      const q = arr(r.questions).filter((x) => typeof x === 'string'), x = curTask(r);
      kind = 'ask';
      body = `<div><b>${tm(q.length ? tv('lv_youAsk', { n: q.length, d: since(ts(r.since), now) }) : t('lv_youAsk0'))}</b> ${esc(x ? t('lv_youHowTask', { k: x.k }) : t('lv_youHow'))}</div>${q.length ? `<ol>${q.map((y) => `<li>${esc(y)}</li>`).join('')}</ol>` : ''}`;
    } else if (r.status === 'stall' || r.status === 'hang') { kind = ''; body = `<div>${esc(t('lv_youStall', { id: s.id }))}</div>`; }
    else if (r.status === 'stopped') { kind = ''; body = `<div>${esc(t('lv_youStopped'))}</div>`; }
    else if (r.status === 'planned') { kind = ''; body = `<div>${esc(tv('lv_plannedTx', { ids: waitIds(r) }))}.</div>`; }
    else if (r.status === 'done') body = `<div>${esc(t('lv_youDone'))}</div>`;
    else { const e = ts(r.eta); body = `<div>${esc(e != null ? t('lv_youNowEta', { t: clock(e) }) : t('lv_youNow'))}</div>`; }
    return `<div class="hp-box you ${kind} ${cls}"><h4>${esc(t('p_you'))}</h4>${body}</div>`;
  }
  function timeHtml(r, now) {
    const a = ts(r.startedAt), tasks = tasksOf(r), done = tasks.filter((x) => x.state === 'done').length, e = ts(r.eta);
    const end = r.status === 'done' ? ts(r.since) || now : now;
    const rows = [a != null ? [t('lv_start'), esc(clock(a))] : null, a != null ? [t('lv_elapsed'), `<b>${tm(durS((end - a) / 1000))}</b>`] : null,
      tasks.length ? [t('lv_tasksDone'), esc(t('lv_ofN', { d: done, n: tasks.length }))] : null,
      e != null && !OVER.includes(r.status) ? [t('lv_eta'), esc(r.status === 'waiting-user' ? t('lv_etaAfter') : t('lv_about', { t: clock(e) }))] : null].filter(Boolean);
    return rows.length ? `<div class="hp-box"><h4>${esc(t('lv_time'))}</h4>${rows.map(([k, v]) => `<div class="line"><span>${esc(k)}</span><span class="num">${v}</span></div>`).join('')}</div>` : '';
  }
  function costHtml(r) {
    const c = r.cost && typeof r.cost === 'object' ? r.cost : {}, sp = numv(c.spentM), pr = price(c), fc = OVER.includes(r.status) ? null : numv(c.forecastM);
    if (sp == null && !pr) return '';
    const max = Math.max(pr ? pr[1] * 1.25 : 0, (sp || 0) * 1.1, (fc || 0) * 1.1) || 1;
    const pc = (x) => `${Math.min(100, Math.max(0, (x / max) * 100)).toFixed(1)}%`;
    const ref = fc != null && r.status !== 'done' ? fc : r.status === 'done' ? sp : sp != null && pr && sp > pr[1] ? sp : null;
    const fit = pr && ref != null ? (ref > pr[1] ? 'above' : ref < pr[0] ? 'below' : 'in') : null;
    const pl = t(c.priceBasis === 'estimate' ? 'lv_priceEst' : 'lv_price'), rg = pr ? `${nf(pr[0], 1)}–${nf(pr[1], 1)} ${t('mln')}` : t('lv_noPrice');
    const aria = [`${t('lv_spent')} ${sp != null ? fmtM(sp) : '—'}`, `${pl} ${rg}`, fc != null ? `${t('lv_forecast')} ${fmtM(fc)}` : ''].filter(Boolean).join('; ');
    return `<div class="hp-box"><h4>${esc(t('lv_cost'))}</h4><div class="line"><span>${esc(t('lv_spent'))}</span><b class="num">${esc(sp != null ? fmtM(sp) : '—')}</b></div>
      <div class="cbar" role="img" aria-label="${esc(aria)}">${pr ? `<div class="band" style="left:${pc(pr[0])};width:calc(${pc(pr[1])} - ${pc(pr[0])})"></div>` : ''}
        ${sp != null ? `<div class="fill" style="width:${pc(sp)}"></div>` : ''}${fc != null ? `<div class="fc" style="left:${pc(fc)}"></div>` : ''}
        ${pr ? `<span class="lbl" style="left:${pc(pr[0])}">${esc(nf(pr[0], 1))}</span><span class="lbl" style="left:${pc(pr[1])}">${esc(nf(pr[1], 1))}</span>` : ''}</div>
      <div class="line"><span>${esc(pl)}</span><span class="num">${esc(rg)}</span></div>
      ${fc != null ? `<div class="line"><span>${esc(t('lv_forecast'))}</span><span class="num" style="white-space:nowrap">${esc(fmtM(fc))}</span></div>` : ''}
      ${fit ? `<div class="line"><span></span><span class="lv-fit ${fit}">${esc(t('lv_fit_' + fit))}</span></div>` : ''}</div>`;
  }
  const PART = {
    ind: (s, r, now) => ind(r, now),
    alert: (s, r, now) => alertHtml(r, now),
    youM: (s, r, now) => youHtml(s, r, now, 'you-m'),
    prog: (s, r, now) => progHtml(r, now),
    feed: (s, r) => feedHtml(s.id, r),
    tech: (s, r) => techHtml(r),
    youD: (s, r, now) => youHtml(s, r, now, 'you-d'),
    side: (s, r, now) => timeHtml(r, now) + costHtml(r),
  };
  const part = (k, s, r, now) => { const h = PART[k](s, r, now); return `<div data-lv-part="${k}" data-lv-h="${sigOf(h)}">${h}</div>`; };
  // The sprint card of a live run: human "why", then the live sections; mockups and decisions stay on the side.
  function lvPanel(s, r, head, x) {
    const now = Date.now();
    const main = part('youM', s, r, now) + part('alert', s, r, now) + x.why + part('prog', s, r, now) + part('feed', s, r, now)
      + `<details class="hp-tech" data-lv-tech="1"><summary>${esc(t('lv_tech'))}</summary>${part('tech', s, r, now)}</details>` + x.tech;
    // The workplace box (static) sits right after "Od Ciebie", as on the card without a run.
    return { head, main, side: part('youD', s, r, now) + (x.wbox || '') + part('side', s, r, now) + x.extra };
  }

  // In-place update: board slots, the open sprint card's parts; a full board render only when placement changes.
  function lvApply(withFeed) {
    if (!LV.snap) return;
    const now = Date.now();
    LV.stale = isStale(now);
    if (TAB === 'roadmap') {
      if (boardSig() !== LV.sig) document.getElementById('page').innerHTML = renderRoadmap();
      else document.querySelectorAll('[data-lv-slot]').forEach((el) => { const r = runOf(el.dataset.lvSlot); if (r) put(el, lvCard(r, now)); });
    }
    const wrap = LV.modal && document.getElementById('modal-wrap'), s = LV.modal && sprintById(LV.modal), r = s && runOf(s.id);
    if (!wrap || !s || !r) return; // no card open, or its run left the snapshot: keep the last known content
    const y = wrap.scrollTop, parts = wrap.querySelectorAll('[data-lv-part]');
    if (!parts.length) { // the sprint started while its card was open: rebuild the card in place
      const p = sprintPanel(s);
      wrap.querySelector('.m-head > div').innerHTML = p.head;
      wrap.querySelector('.m-body').innerHTML = `<div style="min-width:0">${p.main}</div><div class="hp-side">${p.side}</div>`;
    } else parts.forEach((el) => { const k = el.dataset.lvPart; if (PART[k] && (withFeed || k !== 'feed')) put(el, PART[k](s, r, now)); });
    wrap.scrollTop = y;
  }
  function lvTake(sn) {
    if (!sn || typeof sn !== 'object' || (LV.snap && sn.writtenAt && sn.writtenAt === LV.snap.writtenAt)) return;
    const first = !LV.snap;
    LV.snap = sn;
    lvIndex();
    // The newest feed row of each run flashes once when it changed since the previous snapshot.
    const top = {};
    LV.flash = {};
    for (const [id, r] of Object.entries(LV.by)) { const f = arr(r.feed)[0]; top[id] = f ? fkey(f) : ''; if (!first && f && LV.top[id] !== top[id]) LV.flash[id] = top[id]; }
    LV.top = top;
    lvApply(true);
    LV.flash = {};
  }
  function lvPoll() {
    clearTimeout(LV.timer);
    if (document.hidden) return;
    const my = ++LV.seq, old = document.getElementById('dwmt-live');
    if (old) old.remove();
    const el = document.createElement('script');
    const wait = () => (LV.fail ? Math.max(ivl(), Math.min(60, ivl() * 2 ** LV.fail)) : ivl());
    const next = () => { if (my === LV.seq) LV.timer = setTimeout(lvPoll, wait() * 1000); };
    el.id = 'dwmt-live';
    el.onload = () => { if (my === LV.seq) { LV.fail = 0; try { lvTake(window.__dwmtLive); } catch (e) { /* malformed snapshot: keep the last one */ } } next(); };
    // No live.js (no run since the page was made): poll on quietly, each miss doubling the wait up to 60 s.
    el.onerror = () => { if (my === LV.seq) LV.fail = Math.min(10, (LV.fail || 0) + 1); next(); };
    el.src = LIVE.src ? LIVE.src + '?t=' + Date.now() : 'live.js?t=' + Date.now();
    document.head.appendChild(el);
  }

  // ---------- workplaces (K7, sketch 006 variant C; only with D.workplaces) ----------
  // Badge with the position on workplace sprint cards, the switcher under the tabs, the "Wszystkie" rows or the selected
  // strip above the stats (git facts as of the page generation), the push box with a copy button. The K10 actions of the
  // sketch are not built: their places stay as empty `.k10-slot` elements (D-19).
  const WPS = Array.isArray(D.workplaces) ? D.workplaces : [];
  const WP = Object.fromEntries(WPS.map((w) => [w.name, w]));
  const wsel = { w: store.get('w') || 'all' };
  const wCur = () => (wsel.w === 'all' || wsel.w === 'main' || WP[wsel.w] ? wsel.w : 'all');
  const inW = (s, w) => w === 'all' || (w === 'main' ? !(s.wp && WP[s.wp.name]) : !!s.wp && s.wp.name === w);
  const countW = (w) => [...OPEN, ...reviewArch].filter((s) => inW(s, w)).length;
  const BR_IC = '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M5 3.25a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0zm0 2.12a2.25 2.25 0 1 0-1.5 0v5.26a2.25 2.25 0 1 0 1.5 0V9.5c.5.3 1.1.5 1.75.5h2a2.5 2.5 0 0 0 2.4-1.86 2.25 2.25 0 1 0-1.53-.2A1 1 0 0 1 8.75 8.5h-2A1.75 1.75 0 0 1 5 6.75zM4.25 12a.75.75 0 1 1 0 1.5.75.75 0 0 1 0-1.5zm7.5-6a.75.75 0 1 1 0 1.5.75.75 0 0 1 0-1.5z"/></svg>';
  const SLOT = '<span class="k10-slot" aria-hidden="true"></span>';
  const plural = (n, k) => t('wp_' + k + (n === 1 ? 1 : ui() === 'pl' && n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? 2 : 5));
  const nOf = (n, k) => `${n} ${plural(n, k)}`;
  const wpCls = (w) => 'wpc' + ((Number(w.ci) || 0) % 6);
  const mainB = () => D.mainBranch || '—';
  const wpAt = () => { try { return new Intl.DateTimeFormat(locale(), { hour: '2-digit', minute: '2-digit' }).format(new Date(D.generatedAt)); } catch (e) { return ''; } };
  const atHtml = () => `<span class="subtle wp-at" title="${esc(t('wp_atTitle'))}">${esc(t('wp_at', { t: wpAt() }))}</span>`;
  const wpBadge = (w, pos) => `<span class="wpb ${wpCls(w)}" title="${esc(t('wp_title', { name: w.name }))}">${BR_IC}${esc(w.name)}${pos ? ` · ${esc(t('wp_pos', { k: pos.k, n: pos.n }))}` : ''}</span>`;
  const pushReady = (w) => !!w.ready && !w.facts.pushed;
  const WP_PILL = { pushed: 'closed', attn: 'review', running: 'inprogress', ready: 'ready', waiting: 'todo' };
  const wpPill = (w) => pill(WP_PILL[w.state] || 'todo', t('wp_st_' + (WP_PILL[w.state] ? w.state : 'waiting')));
  function abHtml(w) {
    const f = w.facts;
    if (f.ahead == null || f.behind == null) return `<span class="ab muted">${esc(t('wp_abNone', { base: f.baseRef || '—' }))}</span>`;
    return `<span class="ab" title="${esc(t('wp_abTitle', { br: w.branch, base: f.baseRef }))}">${esc(t('wp_ab', { a: f.ahead }))} · <span class="${f.behind >= w.farBehind ? 'bad' : ''}">${esc(t('wp_bb', { b: f.behind }))}</span> ${esc(f.baseRef)}</span>`;
  }
  const pushedHtml = (w) => (w.facts.pushed ? `<span class="ok-t">${esc(t('wp_pushedYes', { r: w.facts.remote || 'origin', br: w.branch }))}</span>` : `<span class="muted">${esc(t('wp_no'))}</span>`);
  const dirtyHtml = (w) => (w.facts.dirty ? `<span class="warn">${esc(nOf(w.facts.dirty, 'file'))}</span>` : `<span class="muted">${esc(w.facts.dirty == null ? '—' : t('wp_none'))}</span>`);
  const baseHtml = (w) => (w.base ? `${esc(w.base.ref)} · ${esc(fmtDate(w.base.at))} <span class="id">${esc(String(w.base.commit || '').slice(0, 7))}</span>` : '—');
  const SEQ = { done: ['done', '✓ '], uat: ['uat', '! '], running: ['run', '● '], queued: ['', ''] };
  const seqHtml = (w) => `<span class="seq">${w.sprints.map((x, i) => {
    const [c, ic] = x.state === 'queued' && w.facts.dirty ? ['held', '‖ '] : SEQ[x.state] || SEQ.queued;
    return `${i ? '<span class="ar">→</span>' : ''}<span class="s ${c}" data-open="${esc(x.id)}" title="${esc(S[x.id] ? sTitle(S[x.id]) : x.id)}">${ic}${esc(x.id)}</span>`;
  }).join('')}</span>`;
  function attnList(w) {
    const li = (w.attention || []).map((a) => {
      if (a.key === 'uat') return `<b>${esc(t('wp_a_uat', { id: a.id }))}</b> <span class="muted">${esc(t('wp_a_uatTx', { br: w.branch, main: mainB() }))}</span>`;
      if (a.key === 'dirty') {
        const files = (a.files || []).map((f) => `<code>${esc(f)}</code>`).join(', ') + (a.n > (a.files || []).length ? ' ' + esc(t('more', { n: a.n - a.files.length })) : '');
        return `<b>${esc(t('wp_a_dirty', { f: nOf(a.n, 'file') }))}</b> <span class="muted">${esc(a.held ? t('wp_a_dirtyHeld', { id: a.held }) : t('wp_a_dirtyIdle'))}${esc(t('wp_a_files'))}${files}.</span>`;
      }
      if (a.key === 'behind') return `<b>${esc(t('wp_a_behind', { c: nOf(a.n, 'com'), base: a.ref }))}</b> <span class="muted">${esc(t('wp_a_behindTx', { at: fmtDate(a.since), base: a.ref }))}</span>`;
      return '';
    }).filter(Boolean);
    return li.length ? `<ul class="attn">${li.map((x) => `<li>${x}</li>`).join('')}</ul>` : '';
  }
  const copyCmd = (w) => `<div class="cmd"><code>${esc(w.facts.pushCmd)}</code><button type="button" class="copy-btn" data-copy="${esc(w.facts.pushCmd)}">${esc(t('wp_copy'))}</button></div>`;
  function pushBox(w) {
    if (!pushReady(w)) return '';
    const f = w.facts;
    const after = t('wp_after') + (f.behind ? t('wp_afterBehind', { c: nOf(f.behind, 'com'), base: f.baseRef }) : '');
    return `<div class="push-box"><div class="ttl"><span>✓ ${esc(t('wp_pushTtl'))} <code>${esc(w.branch)}</code>, ${esc(nOf(w.sprints.length, 'spr'))}</span>${f.ahead != null ? `<span class="muted">${esc(t('wp_pushSub', { c: nOf(f.ahead, 'com'), main: mainB() }))}</span>` : ''}</div>
      <div class="push-row">${copyCmd(w)}${SLOT}</div><div class="after">${esc(after)}</div></div>`;
  }
  const facts = (w) => `${abHtml(w)}<span class="sp"></span><span>${esc(t('wp_pushedL'))} ${pushedHtml(w)}</span><span class="sp"></span><span>${esc(t('wp_dirtyL'))} ${dirtyHtml(w)}</span>`;
  function switcher() {
    const w = wCur();
    const btn = (key, cls, label, mark) => `<button type="button" class="wsel ${cls} ${w === key ? 'on' : ''}" data-w="${esc(key)}">${cls ? '<span class="wp-dot"></span>' : ''}${esc(label)} <span class="n">${countW(key)}</span>${mark}</button>`;
    return `<div class="wpc-bar"><span class="lbl">${esc(t('wp_label'))}</span>${btn('all', '', t('wp_all'), '')}${btn('main', 'wp-main', t('wp_main'), '')}${WPS.map((x) => btn(x.name, wpCls(x), x.name,
      pushReady(x) ? ' <span class="ok-t">✓</span>' : (x.attention || []).length ? ' <span class="warn">!</span>' : '')).join('')}${SLOT}</div>`;
  }
  // Above the stats: one facts row per workplace (all), the main tree line, or the selected workplace's strip.
  function wpTop(w) {
    if (w === 'all') {
      return `<div class="wpc-list">${WPS.map((x) => `<div class="wpc-row ${wpCls(x)}"><span class="nm" data-w="${esc(x.name)}"><span class="wp-dot"></span>${esc(x.name)}</span>${wpPill(x)}${seqHtml(x)}<span class="sp"></span>${facts(x)}
        <span class="end">${pushReady(x) ? copyCmd(x) + SLOT : ''}</span>${attnList(x)}</div>`).join('')}<div class="wpc-foot">${atHtml()}</div></div>`;
    }
    if (w === 'main') return `<div class="wpc-sel wp-main"><div class="sl-row1"><span class="nm"><span class="wp-dot"></span>${esc(t('wp_main'))}</span><code>${esc(mainB())}</code><span class="muted">${esc(t('wp_mainNote', { b: mainB() }))}</span></div></div>`;
    const x = WP[w];
    return `<div class="wpc-sel ${wpCls(x)}"><div class="sl-row1"><span class="nm"><span class="wp-dot"></span>${esc(x.name)}</span>${wpPill(x)}<span class="sp"></span><span>${esc(t('wp_branch'))} <code>${esc(x.branch)}</code></span><span>${esc(t('wp_from'))} ${baseHtml(x)}</span><span class="sp"></span>${facts(x)}<span class="acts">${SLOT}</span></div>
      <div class="sl-row2"><span>${esc(t('wp_seq'))}</span>${seqHtml(x)}<span class="path">${esc(x.facts.tree || x.path || '')}</span>${atHtml()}</div>${attnList(x)}${pushBox(x)}</div>`;
  }
  function wpFoot(s) {
    const w = s.wp && WP[s.wp.name];
    if (!w) return '';
    return wpBadge(w, s.wp) + (['done', 'uat'].includes(s.wp.st) ? `<span class="badge done">✓ ${esc(t(w.facts.pushed ? 'wp_donePushed' : 'wp_doneWait'))}</span>` : '');
  }
  // "Miejsce pracy" on the sprint card, after "Od Ciebie".
  function wpBox(s) {
    const w = s.wp && WP[s.wp.name];
    if (!w) return '';
    const i = w.sprints.findIndex((x) => x.id === s.id), sp = w.sprints[i];
    const prev = i > 0 ? t('wp_afterId', { id: w.sprints[i - 1].id }) : t('wp_first');
    return `<div class="hp-box wp-box"><h4>${esc(t('wp_box'))}</h4><div class="line"><span>${esc(t('wp_name'))}</span>${wpBadge(w)}</div><div class="line"><span>${esc(t('wp_branchL'))}</span><code>${esc(w.branch)}</code></div>
      <div class="line"><span>${esc(t('wp_order'))}</span><span>${esc(t('wp_pos', { k: s.wp.k, n: s.wp.n }))} ${esc(prev)}</span></div>${sp && sp.commit ? `<div class="line"><span>${esc(t('wp_commit'))}</span><span class="id">${esc(String(sp.commit).slice(0, 10))}</span></div>` : ''}
      <div class="wnote">${esc(t('wp_note', { br: w.branch, main: mainB() }))}</div>${SLOT}</div>`;
  }
  // Copy button: the clipboard when the browser gives one (file:// pages may not), "Skopiowane" for a moment; else nothing.
  function copyText(el, text) {
    const nav = typeof navigator !== 'undefined' ? navigator : null;
    const cb = nav && nav.clipboard && typeof nav.clipboard.writeText === 'function' ? nav.clipboard : null;
    if (!cb) return;
    let p;
    try { p = cb.writeText(text); } catch (e) { return; }
    Promise.resolve(p).then(() => { el.textContent = t('wp_copied'); setTimeout(() => { el.textContent = t('wp_copy'); }, 1500); }, () => {});
  }

  // ---------- header ----------
  const TABS = ['roadmap', 'backlog', 'decisions', 'history'];
  let TAB = TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'roadmap';
  function header() {
    const counts = { roadmap: OPEN.length, backlog: OPEN_ITEMS.length, decisions: D.decisions.length, history: (D.history || []).length };
    const goal = D.goal ? `<div class="goal-banner"><span>${esc(t('productGoal'))}</span><b>${esc(tx(D.goal.text, D.goal.tr))}${enIf(untr(D.goal.text, D.goal.tr))}</b></div>` : '';
    return `<div class="app-top"><div class="app-logo" aria-hidden="true">dw</div>
      <div class="app-title">${esc(D.project)}<small>${esc(t('subtitle'))}</small></div>
      <div class="app-meta"><span title="${esc(t('readOnly'))}">${esc(t('generated'))}: ${esc(fmtStamp(D.generatedAt))}</span><span class="gen-long">${esc(t('readOnly'))}</span>
      <span class="seg" role="group" aria-label="language">${LANGS.map((l) => `<button type="button" data-lang="${esc(l)}" class="${l === LANG ? 'on' : ''}">${esc(l.toUpperCase())}</button>`).join('')}</span></div></div>
      <nav class="app-tabs">${TABS.map((k) => `<button type="button" class="app-tab ${k === TAB ? 'active' : ''}" data-tab="${k}">${esc(t(k))}<span class="count">${counts[k]}</span></button>`).join('')}</nav>${WPS.length && TAB === 'roadmap' ? switcher() : ''}${goal}`;
  }

  // ---------- roadmap board ----------
  const ui0 = { more: false };
  function bcard(s, col, i) {
    const r = runOf(s.id);
    const isNext = D.next && D.next.id === s.id && !(r && lvMoved(s));
    const cls = ['bcard', col === 'draft' ? 'draft' : '', isNext ? 'next' : '', col === 'inprogress' ? 'running' : ''].join(' ');
    let right = '';
    if (isNext) right += `<span class="badge next">${esc(t('nextBadge'))}</span>`;
    // A finished or stopped run says so in its live line; "running" would contradict it until the page is regenerated.
    if (col === 'inprogress' && !(r && OVER.includes(r.status))) right += `<span class="badge run">${esc(t(s.state === 'running' || (r && ACTIVE.includes(r.status)) ? 'runRunning' : 'runOrdered'))}</span>`;
    const foot = s.afterOpen.map((a) => afterChip(a, true));
    if (s.wp) foot.unshift(wpFoot(s));
    if (col === 'inprogress' && s.halt) foot.push(`<span class="badge need">${esc(t('halt_' + s.halt.kind))}</span>`);
    if (col === 'todo') {
      if (s.state === 'ready') foot.push(`<span class="badge go">✓ ${esc(t('goBadge'))}</span>`);
      else s.needs.forEach((n) => foot.push(`<span class="badge need">${esc(t('need_' + n))}</span>`));
    }
    return `<div class="${cls}" data-open="${esc(s.id)}" role="button" tabindex="0">
      <div class="top">${col === 'todo' ? `<span class="ord">${i + 1}.</span>` : ''}<span class="id">${esc(s.id)}</span>${kind(s.kind)}<span class="right">${right}</span></div>
      <div class="title">${esc(sTitle(s))}${enIf(s.synthetic && LANG !== 'en')}</div><div class="foot">${foot.join('')}</div>${r ? ((c) => `<div data-lv-slot="${esc(s.id)}" data-lv-h="${sigOf(c)}">${c}</div>`)(lvCard(r, Date.now())) : ''}</div>`;
  }
  const ucard = (s) => `<div class="bcard compact" data-open="${esc(s.id)}" role="button" tabindex="0"><div class="top"><span class="id">${esc(s.id)}</span><span class="right subtle">${s.merged ? esc(fmtDate(s.merged)) : ''}</span></div>
    <div class="title">${esc(sTitle(s))}</div>${s.wp ? `<div class="foot">${wpFoot(s)}</div>` : ''}</div>`;
  function renderRoadmap() {
    // Columns as generated, with live runs moved into "In progress" (and runs without a sprint on this page added there);
    // with workplaces only the sprints of the chosen switcher entry.
    const W = WPS.length ? wCur() : 'all';
    const keep = (s) => inW(s, W);
    const bc = Object.fromEntries(COLS.map((c) => [c, cols[c].filter((s) => !lvMoved(s) && keep(s))]));
    bc.inprogress = [...bc.inprogress, ...D.sprints.filter((s) => lvMoved(s) && keep(s)), ...Object.values(LV.synth).filter(keep)];
    const rv = reviewArch.filter((s) => !lvMoved(s) && keep(s));
    LV.sig = boardSig();
    const n = (c) => bc[c].length + (c === 'review' ? rv.length : 0);
    const shown = ui0.more ? rv : rv.slice(0, 6);
    const bugs = OPEN_ITEMS.filter((b) => b.type === 'bug').length, major = OPEN_ITEMS.filter((b) => b.sev === 'major' || b.sev === 'blocker').length;
    const strip = `<div class="stats"><div class="grp">${['todo', 'inprogress', 'review', 'draft'].map((c) => `<span>${pill(c)}<b>${n(c)}</b></span>`).join('')}</div><div class="sep"></div>
      <div class="grp"><span><span class="muted">${esc(t('sum_backlog'))}</span><b>${OPEN_ITEMS.length}</b></span><span>${kind('bug', true)} ${esc(t('sum_bugs'))} <b>${bugs}</b></span><span>${esc(t('sum_major'))} <b>${major}</b></span>
      ${staleN ? `<span><span class="warn">⚠</span><button type="button" class="link-btn" data-tab="backlog">${staleN} ${esc(t('sum_stale'))}</button></span>` : ''}</div></div>`;
    const colHtml = (c) => {
      const all = c === 'review' ? [...bc[c], ...rv] : bc[c];
      const mark = enIf(all.some((s) => !s.synthetic && sUntr(s)));
      const body = bc[c].map((s, i) => bcard(s, c, i)).join('') + (c === 'review' ? shown.map(ucard).join('') + (rv.length > 6 ? `<button type="button" class="link-btn" data-more="1">${esc(ui0.more ? t('showLess') : t('more', { n: rv.length - 6 }))}</button>` : '') : '');
      return `<section class="col c-${c}" aria-label="${esc(t('st_' + c))}"><div class="col-head">${pill(c)}${mark}<span class="n">${n(c)}</span></div><div class="col-hint">${esc(t('h_' + c))}</div>
        <div class="col-body">${body || `<div class="col-empty">${esc(t('empty'))}</div>`}</div></section>`;
    };
    return `<div class="page">${WPS.length ? wpTop(W) : ''}${strip}<div class="board">${COLS.map(colHtml).join('')}</div></div>`;
  }

  // ---------- sprint card ----------
  function sprintPanel(s) {
    const r = runOf(s.id);
    const st = r && lvMoved(s) ? 'inprogress' : stateOf(s), fy = s.forYou, fb = s.fallback;
    const head = `<div class="hp-head"><div class="row">${pill(st)}<span class="id">${esc(s.id)}</span>${kind(s.kind)}${s.alias ? `<span class="subtle">${esc(s.alias)}</span>` : ''}${s.open && s.current ? `<span class="badge run">▶ ${esc(t('now'))}</span>` : ''}${s.wp && WP[s.wp.name] ? wpBadge(WP[s.wp.name]) : ''}${r ? part('ind', s, r, Date.now()) : ''}</div>
      <div class="hp-title">${esc(sTitle(s))}${enIf(sUntr(s))}</div></div>`;
    let main = '';
    if (fy) {
      main += `<p class="hp-why">${esc(fy.why)}</p>`;
      if (fy.changes && fy.changes.length) main += `<div class="hp-sec"><h3>${esc(t('p_changes'))}</h3>${hlist(fy.changes, 'changes')}</div>`;
      if (fy.notIncluded && fy.notIncluded.length) main += `<div class="hp-sec"><h3>${esc(t('p_not'))}</h3>${hlist(fy.notIncluded, 'not')}</div>`;
      if (fy.check && fy.check.length && st === 'review') main += `<div class="hp-sec"><h3>${esc(t('p_check'))}</h3>${hlist(fy.check, 'steps')}</div>`;
    } else if (st === 'draft') {
      main += `<div class="hp-missing">${esc(t(s.hasFile ? 'noHumanDraft' : 'noFile'))}</div>`;
      if (fb && fb.goal) main += `<div class="hp-sec"><h3>${esc(t('p_goalFile'))}${enIf(LANG !== 'en')}</h3><p class="hp-why">${esc(fb.goal)}</p></div>`;
      if (fb && fb.notes.length) main += `<div class="hp-sec"><h3>${esc(t('p_notes'))}${enIf(LANG !== 'en')}</h3>${hlist(fb.notes, 'plain')}</div>`;
    } else if (fb) {
      if (s.open || st === 'review') main += `<div class="hp-missing">${esc(t('noHuman'))}</div>`;
      if (fb.goal) main += `<div class="hp-sec"><h3>${esc(t('p_goalFile'))}${enIf(LANG !== 'en')}</h3><p class="hp-why">${esc(fb.goal)}</p></div>`;
      if (fb.changes.length) main += `<div class="hp-sec"><h3>${esc(t('p_changes'))}${enIf(LANG !== 'en')}</h3>${hlist(fb.changes, 'changes')}</div>`;
      if (fb.notIncluded.length) main += `<div class="hp-sec"><h3>${esc(t('p_not'))}${enIf(LANG !== 'en')}</h3>${hlist(fb.notIncluded, 'not')}</div>`;
    } else main += `<div class="hp-missing">${esc(t('noFile'))}</div>`;

    // "From you"
    let you, ok = false;
    if (st === 'draft') you = [t('you_draft')];
    else if (st === 'todo') {
      const ql = s.questionList || [];
      // The user's questions as bullets (translated when the memory has them), one EN mark for the list.
      const qHtml = () => ({ html: `${esc(t('you_answersList'))}${enIf(ql.some((q) => untr(q.text, q.tr)))}<ul>${ql.map((q) => `<li>${esc(tx(q.text, q.tr))}</li>`).join('')}</ul>` });
      you = (s.state === 'ready' ? [] : s.needs).map((x) => (x === 'mockup' ? t('you_mockup') : x === 'price' ? t('you_price') : ql.length ? qHtml() : t('you_answers', { n: s.questions })));
      if (!you.length) { you = [t('you_ok')]; ok = true; }
    } else if (st === 'inprogress' && s.halt) you = [t('you_halt_' + s.halt.kind, { r: s.halt.reason || '-' })];
    else if (st === 'inprogress') { you = [t('you_run')]; ok = true; }
    else if (st === 'review' && !s.open && s.wp && WP[s.wp.name]) { you = [t('wp_youClosed', { br: WP[s.wp.name].branch })]; ok = true; }
    else if (st === 'review') you = [fy && fy.check && fy.check.length ? t('you_uat') : t('you_uatNoSteps')];
    else { you = [t('you_closed')]; ok = true; }
    const youBox = (cls) => `<div class="hp-box you ${ok ? 'ok' : ''} ${cls}"><h4>${esc(t('p_you'))}</h4><ul>${you.map((x) => `<li>${x && x.html != null ? x.html : esc(x)}</li>`).join('')}</ul></div>`;
    main = youBox('you-m') + main;
    const wbox = wpBox(s);
    let side = youBox('you-d') + wbox;

    if (s.open && st !== 'review') {
      const col = cols[st] || [], idx = col.indexOf(s);
      side += `<div class="hp-box"><h4>${esc(t('p_queue'))}</h4><div>${esc(t('q_pos', { n: idx + 1, c: t('st_' + st) }))}</div><div class="subtle">${esc(t('q_roadmap', { n: s.pos, m: OPEN.length }))}</div>
        ${s.afterOpen.length ? `<div class="muted" style="margin-top:6px">${esc(t('p_after'))}:</div>${s.afterOpen.map((x) => `<div class="dep">${afterChip(x)}<span>${esc(S[x] ? sTitle(S[x]) : '')}</span></div>`).join('')}` : ''}</div>`;
    }
    if (!s.open || s.state === 'done') {
      const f = fitOf(s.tokensM, s.estRange);
      side += `<div class="hp-box"><h4>${esc(t('p_result'))}</h4><div class="line"><span>${esc(t(s.dropped ? 'f_state' : 'mergedOn'))}</span><b>${esc(s.dropped ? t('st_dropped') : fmtDate(s.merged))}</b></div>
        ${s.files != null ? `<div class="line"><span>${esc(t('files'))}</span><b class="num">${s.files}</b></div>` : ''}${s.tokensM != null ? `<div class="line"><span>${esc(t('tokens'))}</span><b class="num">${esc(fmtM(s.tokensM))}</b></div>` : ''}${s.perFile != null ? `<div class="line"><span>${esc(t('k_perFile'))}</span><span class="num">${esc(fmtM(s.perFile))}</span></div>` : ''}
        ${s.estRange ? `<div class="line"><span>${esc(t('est'))}</span><span class="num muted">${esc(fmtRange(s.estRange))}</span></div>${f ? `<div class="line"><span></span>${fitHtml(f)}</div>` : ''}` : ''}
        ${s.uat ? `<div class="line"><span>${esc(t('uat'))}</span><span>${esc(T[ui()]['uat_' + s.uat] || s.uat)}</span></div>` : ''}</div>`;
    } else if (st !== 'draft') {
      const an = s.analogs || [];
      if (s.estRange || an.length) side += `<div class="hp-box"><h4>${esc(t('p_scale'))}</h4>${s.estRange ? `<div class="line"><span>${esc(t('est'))}</span><b class="num">${esc(fmtRange(s.estRange))}</b></div>` : ''}
        ${an.length ? `<div class="muted" style="font-size:var(--text-sm);margin-top:4px">${esc(t('analog'))}:</div>${an.map((x) => `<div class="line">${chip(x.id)}<span class="num">${x.files} ${esc(t('filesN'))} · ${esc(fmtM(x.tokensM))}</span></div>`).join('')}` : ''}</div>`;
    }
    const mockBox = s.ui ? `<div class="hp-box"><h4>${esc(t('p_mockups'))}</h4>${s.mockups.length ? s.mockups.map((m) => `<div><a href="${esc(m.href)}" target="_blank" rel="noopener">${esc(m.path.split('/').pop())}</a></div>`).join('') : `<div class="muted">${esc(t('mockPending'))}</div>`}</div>` : '';
    const decBox = s.decisions.length ? `<div class="hp-box"><h4>${esc(t('p_decisions'))}${enIf(s.decisions.some((d) => untr(d.title, d.titleTr)))}</h4><ul>${s.decisions.map((d) => `<li data-pd="${esc(d.id)}" style="cursor:pointer" title="${esc(DECS[d.id] ? DECS[d.id].decision : '')}">${esc(d.title ? tx(d.title, d.titleTr) : d.id)}</li>`).join('')}</ul></div>` : '';
    side += mockBox + decBox;

    let tech = '';
    if (s.hasFile) {
      const facts = [[t('p_mode'), s.mode], [t('est'), s.est], [t('p_readyAt'), s.readyAt ? fmtDate(s.readyAt) : null], [t('p_run'), s.run]].filter((x) => x[1]);
      const its = [...s.items.map((i) => [i, '']), ...s.touch.map((i) => [i, t('p_touch')])];
      tech = `<details class="hp-tech"><summary>${esc(t('p_tech'))}</summary>
        ${facts.length ? `<div class="dsec"><h3>${esc(t('p_header'))}</h3><dl class="kv2">${facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl></div>` : ''}
        ${its.length ? `<div class="dsec"><h3>${esc(t('p_items'))}</h3>${its.map(([i, note]) => { const b = ITEMS[i]; return `<div class="item-row" ${b ? `data-item="${esc(i)}" style="cursor:pointer"` : ''}>${b ? kind(b.type, true) : ''}<span class="id">${esc(i)}</span><span>${esc(b ? b.title : '')}</span>${note ? `<span class="subtle">${esc(note)}</span>` : ''}</div>`; }).join('')}</div>` : ''}
        ${s.sections.map(([k, v]) => `<div class="dsec"><h3>${esc(k)}</h3>${textBlock(v)}</div>`).join('')}</details>`;
    }
    if (r) {
      const why = fy ? `<p class="hp-why">${esc(fy.why)}</p>` : fb && fb.goal && !s.synthetic ? `<p class="hp-why">${esc(fb.goal)}${enIf(LANG !== 'en')}</p>` : '';
      return lvPanel(s, r, head, { why, tech, wbox, extra: mockBox + decBox });
    }
    return { head, main: main + tech, side };
  }

  // ---------- modal ----------
  let lastFocus = null;
  function showModal(head, main, side) {
    closeModal(true);
    lastFocus = document.activeElement;
    document.body.insertAdjacentHTML('beforeend', `<div class="modal-wrap" id="modal-wrap"><div class="modal" role="dialog" aria-modal="true" tabindex="-1"><div class="m-head"><div>${head}</div>
      <button type="button" class="m-close" data-close="1" aria-label="${esc(t('close'))}">×</button></div>
      <div class="m-body"><div style="min-width:0">${main}</div><div class="hp-side">${side}</div></div></div></div>`);
    document.getElementById('overlay').classList.add('open');
    document.body.classList.add('modal-open');
    const m = document.querySelector('#modal-wrap .modal');
    requestAnimationFrame(() => { m.classList.add('open'); m.focus({ preventScroll: true }); });
  }
  function closeModal(keep) {
    const w = document.getElementById('modal-wrap');
    if (w) w.remove();
    LV.modal = null;
    if (keep) return;
    document.getElementById('overlay').classList.remove('open');
    document.body.classList.remove('modal-open');
    if (lastFocus && lastFocus.focus) { try { lastFocus.focus({ preventScroll: true }); } catch (e) { /* gone */ } }
  }
  function openSprint(id) { const s = sprintById(id); if (!s) return; const p = sprintPanel(s); showModal(p.head, p.main, p.side); LV.modal = id; }

  // ---------- backlog and decisions ----------
  const TYPES = ['bug', 'feature', 'change', 'debt', 'remark', 'idea', 'mockups'];
  const TYPE_COLOR = { bug: '--kind-bug', feature: '--kind-feature', change: '--kind-change', debt: '--kind-debt', remark: '--kind-remark', idea: '--kind-idea', mockups: '--kind-mockups' };
  const TRI = ['new', 'now', 'sprint', 'touch', 'later', 'never'];
  const u = { q: '', types: [], tri: '', sev: '', closed: false, group: store.get('group') || 'triage', all: {}, dq: '', area: '', against: false, range: 'all', table: false,
    unit: store.get('unit') === 'line' ? 'line' : 'file' };
  if (!['triage', 'sprint', 'type', 'sev'].includes(u.group)) u.group = 'triage';
  const iTitle = (b) => tx(b.title, b.titleTr);
  const iUntr = (b) => !b.closed && untr(b.title, b.titleTr);
  const triLabel = (b) => (b.tri !== 'sprint' ? esc(t('tr_' + b.tri)) : `${esc(t('tr_sprint'))} ${b.sprint ? chip(b.sprint) : ''}${b.stale ? ` <span class="warn" title="${esc(t('staleHint'))}">⚠</span>` : ''}`);
  function filteredItems() {
    const q = u.q.toLowerCase();
    return D.items.filter((b) => (u.closed || !b.closed) && (!u.types.length || u.types.includes(b.type)) && (!u.tri || b.tri === u.tri) && (!u.sev || b.sev === u.sev)
      && (!q || (b.id + ' ' + b.title + ' ' + (b.titleTr || '') + ' ' + (b.note || '') + ' ' + (b.alias || '')).toLowerCase().includes(q)));
  }
  const mix = (rows) => `<span class="mix" aria-hidden="true">${TYPES.map((ty) => { const n = rows.filter((b) => b.type === ty).length; return n ? `<span title="${esc(t('ty_' + ty))} ${n}" style="width:${(n / rows.length) * 100}%;background:var(${TYPE_COLOR[ty]})"></span>` : ''; }).join('')}</span>`;
  function itemGroups(rows) {
    const g = u.group;
    if (g === 'triage') return TRI.map((k) => ({ key: k, label: esc(t('tr_' + k)), hint: t('trh_' + k), rows: rows.filter((b) => b.tri === k), open: k !== 'later' && k !== 'never' }));
    if (g === 'type') return TYPES.map((k) => ({ key: k, label: kind(k, true) + ' ' + esc(t('ty_' + k)), rows: rows.filter((b) => b.type === k), open: rows.filter((b) => b.type === k).length < 60 }));
    if (g === 'sev') return ['blocker', 'major', 'minor', null].map((k) => ({ key: String(k), label: esc(k ? t('sv_' + k) : t('noSev')), rows: rows.filter((b) => (b.sev || null) === k), open: !!k }));
    const ids = [...new Set(rows.map((b) => b.sprint).filter(Boolean))].sort((a, b) => ((S[a] && S[a].pos) || 1e9) - ((S[b] && S[b].pos) || 1e9));
    return [...ids.map((s) => ({ key: s, label: `${chip(s)} ${esc(S[s] ? sTitle(S[s]) : '')}${D.stale && D.stale[s] ? ` <span class="warn" title="${esc(t('staleHint'))}">⚠</span>` : ''}`, rows: rows.filter((b) => b.sprint === s), open: true })),
      { key: '-', label: esc(t('noSprint')), rows: rows.filter((b) => !b.sprint), open: false }];
  }
  const LIMIT = 150;
  const itemRow = (b) => `<div class="r ${b.closed ? 'closed' : ''}" data-item="${esc(b.id)}">${kind(b.type, true)}<span class="id">${esc(b.id)}</span><span class="tt">${esc(iTitle(b))}</span><span>${b.stale ? `<span class="warn" title="${esc(t('staleHint'))}">⚠</span> ` : ''}${sevPill(b.sev)}${b.closed ? pill(b.state === 'dropped' ? 'dropped' : 'closed', t('is_' + b.state)) : ''}</span></div>`;
  function groupsHtml() {
    const rows = filteredItems();
    const base = D.items.filter((b) => u.closed || !b.closed).length;
    const html = itemGroups(rows).filter((g) => g.rows.length).map((g) => {
      const lim = u.all[g.key] ? g.rows.length : LIMIT;
      return `<details class="grp" ${g.open || u.q ? 'open' : ''}><summary>${g.label}${enIf(g.rows.some(iUntr))} <span class="n">${g.rows.length}</span>${g.hint ? `<span class="hint">${esc(g.hint)}</span>` : ''}${mix(g.rows)}</summary>
      <div class="rows">${g.rows.slice(0, lim).map(itemRow).join('')}${g.rows.length > lim ? `<div class="more-row"><button type="button" class="link-btn" data-all="${esc(g.key)}">${esc(t('showAll', { n: g.rows.length }))}</button></div>` : ''}</div></details>`;
    }).join('');
    return { html: html || `<div class="empty">—</div>`, shown: t('shownOf', { a: rows.length, b: base }) };
  }
  function renderBacklog() {
    const base = D.items.filter((b) => u.closed || !b.closed);
    const chips = TYPES.map((ty) => [ty, base.filter((b) => b.type === ty).length]).filter(([, n]) => n).map(([ty, n]) => `<button type="button" class="fchip ${u.types.includes(ty) ? 'on' : ''}" data-type="${ty}">${kind(ty, true)}${esc(t('ty_' + ty))} <b>${n}</b></button>`).join('');
    const sel = (key, all, opts) => `<select data-sel="${key}"><option value="">${esc(all)}</option>${opts.map(([v, l]) => `<option value="${esc(v)}" ${u[key] === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
    const g = groupsHtml();
    const stale = Object.entries(D.stale || {});
    return `<div class="page">${stale.length ? `<div class="warn-line">⚠ ${esc(t('staleBanner', { n: staleN }))} ${stale.map(([s, ids]) => `${chip(s)} ${ids.length}`).join(', ')}</div>` : ''}
      <div class="toolbar"><input type="search" id="q" placeholder="${esc(t('search'))}" value="${esc(u.q)}" aria-label="${esc(t('search'))}">${chips}
      ${sel('tri', t('anyTriage'), TRI.map((k) => [k, t('tr_' + k)]))}${sel('sev', t('anySev'), ['blocker', 'major', 'minor'].map((k) => [k, t('sv_' + k)]))}
      <label>${esc(t('groupBy'))} <select data-sel="group">${['triage', 'sprint', 'type', 'sev'].map((k) => `<option value="${k}" ${u.group === k ? 'selected' : ''}>${esc(t('g_' + k))}</option>`).join('')}</select></label>
      <span class="spacer"></span><label><input type="checkbox" data-check="closed" ${u.closed ? 'checked' : ''}> ${esc(t('showClosed', { n: D.items.filter((b) => b.closed).length }))}</label>
      <span class="shown" id="shown">${esc(g.shown)}</span></div><div class="groups" id="groups">${g.html}</div></div>`;
  }
  function filteredDecisions() {
    const q = u.dq.toLowerCase();
    return D.decisions.filter((d) => (!u.area || d.areas.includes(u.area)) && (!u.against || d.against)
      && (!q || [d.id, d.title, d.titleTr, d.decision, d.why, d.rejected, d.areas.join(' ')].join(' ').toLowerCase().includes(q))).slice().reverse();
  }
  function decGroupsHtml() {
    const rows = filteredDecisions();
    const by = {};
    rows.forEach((d) => { const a = d.areas[0] || 'general'; (by[a] = by[a] || []).push(d); });
    const html = Object.entries(by).sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0])).map(([a, ds]) =>
      `<details class="grp" open><summary>${esc(a)}${enIf(ds.some((d) => untr(d.title, d.titleTr)))} <span class="n">${ds.length}</span></summary><div class="rows">${ds.map((d) => `<div class="r dec" data-pd="${esc(d.id)}"><span class="id">${esc(d.id)}</span>
        <div style="min-width:0"><div class="tt">${esc(tx(d.title, d.titleTr))}</div><div class="sub">${esc(d.decision || '')}</div></div>
        <span>${d.against ? `<span class="warn" title="${esc(t('d_against'))}">⚠</span> ` : ''}<span class="subtle">${esc(fmtDate(d.at))}</span></span></div>`).join('')}</div></details>`).join('');
    return { html: html || `<div class="empty">—</div>`, shown: t('shownOf', { a: rows.length, b: D.decisions.length }) };
  }
  function renderDecisions() {
    const counts = {};
    D.decisions.forEach((d) => d.areas.forEach((a) => { counts[a] = (counts[a] || 0) + 1; }));
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const g = decGroupsHtml();
    return `<div class="page"><div class="toolbar"><input type="search" id="dq" placeholder="${esc(t('searchD'))}" value="${esc(u.dq)}" aria-label="${esc(t('searchD'))}">
      ${top.slice(0, 8).map(([a, n]) => `<button type="button" class="fchip text ${u.area === a ? 'on' : ''}" data-area="${esc(a)}">${esc(a)} <b>${n}</b></button>`).join('')}
      ${top.length > 8 ? `<select data-sel="area"><option value="">${esc(t('allAreas'))}</option>${top.map(([a, n]) => `<option value="${esc(a)}" ${u.area === a ? 'selected' : ''}>${esc(a)} (${n})</option>`).join('')}</select>` : ''}
      <span class="spacer"></span><label><input type="checkbox" data-check="against" ${u.against ? 'checked' : ''}> ${esc(t('d_againstOnly'))}</label>
      <span class="shown" id="shown">${esc(g.shown)}</span></div><div class="groups" id="groups">${g.html}</div></div>`;
  }
  function openItem(id) {
    const b = ITEMS[id]; if (!b) return;
    const head = `<div class="hp-head"><div class="row">${kind(b.type, true)}<span class="muted">${esc(t('ty_' + b.type))}</span><span class="id">${esc(b.id)}</span>${sevPill(b.sev)}</div><div class="hp-title">${esc(iTitle(b))}${enIf(iUntr(b) || (b.closed && LANG !== 'en' && CL !== 'en'))}</div></div>`;
    let main = b.note ? `<div class="hp-sec" style="margin-top:0"><h3>${esc(t('f_note'))}${enIf(LANG !== 'en' && CL !== 'en')}</h3><p class="hp-why">${inline(b.note)}</p></div>` : '';
    if (b.anchors.length) main += `<div class="hp-sec"><h3>${esc(t('f_where'))}</h3><ul class="mono-list">${b.anchors.map((a) => `<li>${esc(a)}</li>`).join('')}</ul></div>`;
    if (b.src) main += `<div class="hp-sec"><h3>${esc(t('f_src'))}</h3><div class="subtle" style="word-break:break-all">${esc(b.src)}</div></div>`;
    const side = `<div class="hp-box"><h4>${esc(t('f_status'))}</h4><dl class="kv2"><dt>${esc(t('f_state'))}</dt><dd>${esc(t('is_' + b.state))}</dd><dt>${esc(t('f_tri'))}</dt><dd>${triLabel(b)}</dd>
      <dt>${esc(t('f_sev'))}</dt><dd>${b.sev ? esc(t('sv_' + b.sev)) : '—'}</dd><dt>${esc(t('f_at'))}</dt><dd>${esc(fmtDate(b.at))}</dd>${b.est ? `<dt>${esc(t('f_est'))}</dt><dd>${esc(b.est)}</dd>` : ''}${b.alias ? `<dt>${esc(t('f_alias'))}</dt><dd>${esc(b.alias)}</dd>` : ''}</dl></div>`;
    showModal(head, main, side);
  }
  function openDecision(id) {
    const d = DECS[id]; if (!d) return;
    const enm = enIf(LANG !== 'en' && CL !== 'en');
    const head = `<div class="hp-head"><div class="row"><span class="id">${esc(d.id)}</span>${d.areas.map((a) => `<span class="area">${esc(a)}</span>`).join('')}</div><div class="hp-title">${esc(tx(d.title, d.titleTr))}${enIf(untr(d.title, d.titleTr))}</div></div>`;
    let main = `<div class="hp-sec" style="margin-top:0"><h3>${esc(t('d_decision'))}${enm}</h3><p class="hp-why">${inline(d.decision || '')}</p></div>`;
    if (d.why) main += `<div class="hp-sec"><h3>${esc(t('d_why'))}</h3><p>${inline(d.why)}</p></div>`;
    if (d.rejected) main += `<div class="hp-sec"><h3>${esc(t('d_rejected'))}</h3><p>${inline(d.rejected)}</p></div>`;
    const side = `<div class="hp-box ${d.against ? 'you' : ''}"><h4>${esc(t('f_status'))}</h4><dl class="kv2"><dt>${esc(t('d_at'))}</dt><dd>${esc(fmtDate(d.at))}</dd><dt>${esc(t('d_by'))}</dt><dd>${esc(T[ui()]['by_' + d.by] || d.by || '—')}</dd>
      <dt>${esc(t('d_against'))}</dt><dd>${d.against ? '⚠ ' + esc(d.against) : esc(t('no'))}</dd></dl></div>`;
    showModal(head, main, side);
  }

  // ---------- history ----------
  const median = (xs) => { const s = xs.slice().sort((a, b) => a - b); const m = s.length >> 1; return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : null; };
  const measured = () => (D.history || []).filter((r) => u.range === 'all' || daysAgo(r.merged) <= +u.range);
  const hTitle = (r) => (S[r.id] ? sTitle(S[r.id]) : r.id);
  function kpis(rows) {
    const tok = rows.reduce((a, r) => a + r.tokensM, 0), files = rows.reduce((a, r) => a + r.files, 0);
    const withEst = rows.filter((r) => r.estRange), inN = withEst.filter((r) => r.fit === 'in').length;
    // Per line: only sprints with known lines (unknown never counts as 0).
    const pl = rows.filter((r) => r.perLineK != null);
    return `<div class="kpis">
      <div class="kpi"><div class="label">${esc(t('k_sprints'))}</div><div class="value">${rows.length}</div><div class="sub">${esc(t('k_files', { n: files }))}</div></div>
      <div class="kpi"><div class="label">${esc(t('k_tokens'))}</div><div class="value">${esc(fmtM(Math.round(tok * 10) / 10))}</div><div class="sub">${rows.length ? esc(fmtDate(rows[0].merged) + ' – ' + fmtDate(rows[rows.length - 1].merged)) : '—'}</div></div>
      <div class="kpi"><div class="label">${esc(t('k_perFile'))}</div><div class="value">${esc(fmtM(rows.length ? Math.round(median(rows.map((r) => r.perFile)) * 1000) / 1000 : null))}</div><div class="sub">${esc(t('k_median'))}</div></div>
      <div class="kpi"><div class="label">${esc(t('k_perLine'))}</div><div class="value">${esc(fmtK(pl.length ? Math.round(median(pl.map((r) => r.perLineK)) * 1000) / 1000 : null))}</div>
        <div class="sub">${esc(pl.length === rows.length ? t('k_median') : t('k_linesOf', { n: pl.length, m: rows.length }))}</div></div>
      <div class="kpi"><div class="label">${esc(t('k_fit'))}</div><div class="value">${withEst.length ? `${inN} / ${withEst.length}` : '—'}</div>
        <div class="sub">${esc(withEst.length ? t('k_fitSub', { a: withEst.filter((r) => r.fit === 'above').length, b: withEst.filter((r) => r.fit === 'below').length }) : t('k_noEst'))}</div></div></div>`;
  }
  function histTable(rows) {
    const max = Math.max(...rows.map((r) => r.tokensM), 1), rmax = Math.max(...rows.map((r) => Math.max(r.tokensM, r.estRange ? r.estRange[1] : 0)), 1);
    return `<div class="card2 tbl-wrap"><table class="grid"><thead><tr><th>${esc(t('c_merged'))}</th><th>${esc(t('c_sprint'))}</th><th>${esc(t('c_kind'))}</th><th class="r">${esc(t('c_files'))}</th><th class="r">${esc(t('c_lines'))}</th><th>${esc(t('c_tokens'))}</th>
      <th class="r">${esc(t('c_perFile'))}</th><th class="r">${esc(t('c_perLine'))}</th><th>${esc(t('c_fit'))}</th><th>${esc(t('c_review'))}</th></tr></thead><tbody>
      ${rows.slice().reverse().map((r) => `<tr data-open="${esc(r.id)}"><td class="subtle">${esc(fmtDate(r.merged))}</td><td class="t"><span class="id">${esc(r.id)}</span> ${esc(hTitle(r))}</td><td>${kind(r.kind)}</td><td class="r num">${r.files}</td><td class="r num">${esc(fmtN(r.lines))}</td>
        <td><div class="tbar"><div class="b" style="width:${(r.tokensM / max) * 110}px"></div><span class="num">${esc(fmtM(r.tokensM))}</span></div></td><td class="r num">${esc(fmtN(r.perFile))}</td><td class="r num">${esc(fmtN(r.perLineK))}</td>
        <td style="white-space:nowrap">${r.estRange ? `<span class="mini-range"><span class="bd" style="left:${(r.estRange[0] / rmax) * 100}%;width:${((r.estRange[1] - r.estRange[0]) / rmax) * 100}%"></span><span class="dt ${r.fit}" style="left:${(r.tokensM / rmax) * 100}%"></span></span>` : ''}${fitHtml(r.fit)}</td>
        <td class="subtle">${esc(r.uat ? T[ui()]['uat_' + r.uat] || r.uat : '—')}</td></tr>`).join('')}</tbody></table></div>`;
  }
  // Cost chart card: title, per file / per line switch (as the feed toggle), subtitle, chart element.
  function ch2Card() {
    const line = u.unit === 'line';
    const seg = `<span class="seg" role="group" aria-label="${esc(t('ch2'))}">${[['file', 'u_file'], ['line', 'u_line']].map(([k, l]) => `<button type="button" data-unit="${k}" class="${u.unit === k ? 'on' : ''}" aria-pressed="${u.unit === k}">${esc(t(l))}</button>`).join('')}</span>`;
    return `<div class="card-head"><h3>${esc(t(line ? 'ch2l' : 'ch2'))}</h3>${seg}</div><div class="sub">${esc(t(line ? 'ch2ls' : 'ch2s'))}</div><div class="chart" id="ch2"></div>`;
  }
  function renderHistory() {
    const rows = measured();
    const older = D.sprints.filter((s) => !s.open && !s.dropped && !(D.history || []).some((h) => h.id === s.id));
    const seg = ['14', '30', 'all'].map((r) => `<button type="button" class="${u.range === r ? 'on' : ''}" data-range="${r}">${esc(t('r_' + r))}</button>`).join('');
    const legend = `<div class="legend-line"><span><i style="width:22px;height:8px;border-radius:4px;background:var(--viz-band)"></i>${esc(t('lg_band'))}</span>
      <span><i style="width:10px;height:10px;border-radius:50%;background:var(--color-text)"></i>${esc(t('lg_in'))}</span><span><i style="width:10px;height:10px;border-radius:50%;background:var(--st-done)"></i>${esc(t('lg_above'))}</span>
      <span><i style="width:10px;height:10px;border-radius:50%;background:var(--color-text-subtle)"></i>${esc(t('lg_below'))}</span></div>`;
    return `<div class="page"><div class="filters"><span class="muted">${esc(t('range'))}</span><div class="seg">${seg}</div></div>${kpis(rows)}
      ${rows.length ? `<div class="charts"><div class="card2"><h3>${esc(t('ch1'))}</h3><div class="sub">${esc(t('ch1s'))}</div><div class="chart" id="ch1"></div></div>
        <div class="card2" id="ch2card">${ch2Card()}</div></div>
        <div class="card2"><h3>${esc(t('ch3'))}</h3><div class="sub">${esc(t('ch3s'))}</div><div class="chart" id="ch3"></div>${legend}</div>
        <div class="tbl-toggle"><button type="button" class="link-btn" data-table="1">${esc(u.table ? t('hideTable') : t('showTable'))}</button></div>${u.table ? histTable(rows) : ''}`
      : `<div class="card2"><div class="empty">${esc(t('noData'))}</div></div>`}
      ${older.length ? `<details class="older"><summary>${esc(t('older', { n: older.length }))}</summary><div class="rows2">${older.map((s) => `<div data-open="${esc(s.id)}" style="cursor:pointer"><span class="id">${esc(s.id)}</span> ${esc(sTitle(s))} <span class="subtle">${s.merged ? esc(fmtDate(s.merged)) : ''}</span></div>`).join('')}</div></details>` : ''}</div>`;
  }
  const niceMax = (v) => { const steps = [0.01, 0.02, 0.025, 0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 2.5, 5, 10, 20, 25, 50, 100, 200, 250, 500]; const s = steps.find((x) => v / x <= 5) || 1000; return { max: Math.ceil(v / s) * s || s, step: s }; };
  function yGrid(W, H, pad, sc) {
    let g = '<g class="grid">';
    for (let v = 0; v <= sc.max + 1e-9; v += sc.step) { const y = pad.t + (H - pad.t - pad.b) * (1 - v / sc.max); g += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y}" y2="${y}"/><text x="${pad.l - 6}" y="${y + 4}" text-anchor="end">${esc(fmtN(v))}</text>`; }
    return g + '</g>';
  }
  const tip = (rows) => esc(JSON.stringify(rows));
  // Date labels under columns: about one per 64 px, the last one always, none crowding it.
  const xLabels = (n, i, plotW) => { const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(plotW / 64)))); return i === n - 1 || (i % every === 0 && n - 1 - i >= Math.ceil(every / 2)); };
  function columnsChart(el, rows) {
    const W = Math.max(el.clientWidth - 8, 260), H = 220, pad = { l: 40, r: 8, t: 18, b: 28 };
    const sc = niceMax(Math.max(...rows.map((r) => r.tokensM), 0.1)), slot = (W - pad.l - pad.r) / rows.length, bw = Math.max(2, Math.min(24, slot * 0.7));
    const y = (v) => pad.t + (H - pad.t - pad.b) * (1 - v / sc.max), maxR = rows.reduce((a, b) => (b.tokensM > a.tokensM ? b : a), rows[0]);
    let s = `<svg class="viz" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(t('ch1'))}">${yGrid(W, H, pad, sc)}`;
    rows.forEach((r, i) => {
      const x = pad.l + slot * i + (slot - bw) / 2, top = y(r.tokensM), rr = Math.min(4, bw / 2, H - pad.b - top);
      s += `<g class="col" data-open="${esc(r.id)}" data-tip="${tip([[fmtM(r.tokensM), hTitle(r)], [fmtDate(r.merged) + ' · ' + r.files + ' ' + t('filesN') + ' · ' + fmtN(r.lines) + ' ' + t('linesN'), ''], [t('perFileShort', { v: fmtN(r.perFile) }), '']])}">
        <rect class="hit" x="${pad.l + slot * i}" y="${pad.t}" width="${slot}" height="${H - pad.t - pad.b}"/><path class="bar" d="M${x},${H - pad.b} V${top + rr} q0,-${rr} ${rr},-${rr} h${bw - 2 * rr} q${rr},0 ${rr},${rr} V${H - pad.b} Z"/></g>`;
      if (r === maxR) s += `<text class="val" x="${x + bw / 2}" y="${top - 5}" text-anchor="middle">${esc(fmtN(r.tokensM))}</text>`;
      if (xLabels(rows.length, i, W - pad.l - pad.r)) s += `<text x="${pad.l + slot * i + slot / 2}" y="${H - 8}" text-anchor="middle">${esc(fmtDate(r.merged))}</text>`;
    });
    el.innerHTML = s + `<line class="axis" x1="${pad.l}" x2="${W - pad.r}" y1="${H - pad.b}" y2="${H - pad.b}"/></svg>`;
  }
  // Cost per file, or (u.unit 'line') thousand tokens per changed line over the sprints with known lines only.
  function lineChart(el, rows) {
    const line = u.unit === 'line', val = (r) => (line ? r.perLineK : r.perFile);
    if (line) rows = rows.filter((r) => r.perLineK != null);
    if (!rows.length) { el.innerHTML = `<div class="empty">${esc(t(line ? 'noLines' : 'noData'))}</div>`; return; }
    const W = Math.max(el.clientWidth - 8, 260), H = 220, pad = { l: 40, r: W < 420 ? 12 : 72, t: 18, b: 28 };
    const sc = niceMax(Math.max(...rows.map(val), 0.01)), slot = (W - pad.l - pad.r) / rows.length;
    const y = (v) => pad.t + (H - pad.t - pad.b) * (1 - v / sc.max), x = (i) => pad.l + slot * i + slot / 2, med = median(rows.map(val));
    let s = `<svg class="viz" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(t(line ? 'ch2l' : 'ch2'))}">${yGrid(W, H, pad, sc)}`;
    s += `<line class="median" x1="${pad.l}" x2="${W - pad.r}" y1="${y(med)}" y2="${y(med)}"/>`;
    if (rows.length > 1) s += `<path class="line" d="${rows.map((r, i) => (i ? 'L' : 'M') + x(i) + ',' + y(val(r))).join(' ')}"/>`;
    const maxR = rows.reduce((a, b) => (val(b) > val(a) ? b : a), rows[0]);
    rows.forEach((r, i) => {
      s += `<g class="col" data-open="${esc(r.id)}" data-tip="${tip(line ? [[t('perLineShort', { v: fmtN(r.perLineK) }), hTitle(r)], [fmtDate(r.merged) + ' · ' + fmtN(r.lines) + ' ' + t('linesN') + ' · ' + r.files + ' ' + t('filesN') + ' · ' + fmtM(r.tokensM), '']]
        : [[t('perFileShort', { v: fmtN(r.perFile) }), hTitle(r)], [fmtDate(r.merged) + ' · ' + r.files + ' ' + t('filesN') + ' · ' + fmtN(r.lines) + ' ' + t('linesN') + ' · ' + fmtM(r.tokensM), '']])}">
        <rect class="hit" x="${pad.l + slot * i}" y="${pad.t}" width="${slot}" height="${H - pad.t - pad.b}"/><line class="cross" x1="${x(i)}" x2="${x(i)}" y1="${pad.t}" y2="${H - pad.b}"/><circle class="dot" cx="${x(i)}" cy="${y(val(r))}" r="4"/></g>`;
      if (r === maxR) s += `<text class="val" x="${x(i)}" y="${y(val(r)) - 8}" text-anchor="middle">${esc(fmtN(val(r)))}</text>`;
      if (xLabels(rows.length, i, W - pad.l - pad.r)) s += `<text x="${x(i)}" y="${H - 8}" text-anchor="middle">${esc(fmtDate(r.merged))}</text>`;
    });
    const mlab = W < 420 ? `<text class="mlbl" x="${W - pad.r}" y="${y(med) - 5}" text-anchor="end">${esc(t('median', { v: fmtN(med) }))}</text>` : `<text class="mlbl" x="${W - pad.r + 4}" y="${y(med) + 4}">${esc(t('median', { v: fmtN(med) }))}</text>`;
    s += mlab;
    el.innerHTML = s + `<line class="axis" x1="${pad.l}" x2="${W - pad.r}" y1="${H - pad.b}" y2="${H - pad.b}"/></svg>`;
  }
  function rangeChart(el, rows) {
    rows = rows.filter((r) => r.estRange).slice().reverse();
    if (!rows.length) { el.innerHTML = `<div class="empty">${esc(t('k_noEst'))}</div>`; return; }
    const W = Math.max(el.clientWidth - 8, 280), narrow = W < 560, rowH = 26;
    const pad = { l: narrow ? Math.round(W * 0.34) : Math.min(260, Math.round(W * 0.3)), r: narrow ? 52 : 110, t: 8, b: 26 }, H = pad.t + rows.length * rowH + pad.b;
    const sc = niceMax(Math.max(...rows.map((r) => Math.max(r.tokensM, r.estRange[1])))), xs = (v) => pad.l + (W - pad.l - pad.r) * (v / sc.max);
    const maxChars = Math.max(8, Math.floor((pad.l - 14) / 6.2));
    let s = `<svg class="viz" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(t('ch3'))}"><g class="grid">`;
    for (let v = 0; v <= sc.max + 1e-9; v += sc.step) s += `<line x1="${xs(v)}" x2="${xs(v)}" y1="${pad.t}" y2="${H - pad.b}"/><text x="${xs(v)}" y="${H - 8}" text-anchor="middle">${esc(fmtN(v))}</text>`;
    s += '</g>';
    rows.forEach((r, i) => {
      const cy = pad.t + i * rowH + rowH / 2, f = r.fit, d = f === 'above' ? r.tokensM - r.estRange[1] : f === 'below' ? r.tokensM - r.estRange[0] : 0;
      const title = hTitle(r), short = title.length > maxChars ? title.slice(0, maxChars - 1) + '…' : title;
      s += `<g class="col" data-open="${esc(r.id)}" data-tip="${tip([[fmtM(r.tokensM), title], [t('est') + ': ' + fmtRange(r.estRange), ''], [FIT_IC[f] + ' ' + t('fit_' + f), '']])}">
        <rect class="hit" x="0" y="${cy - rowH / 2}" width="${W}" height="${rowH}"/><text class="lbl" x="${pad.l - 10}" y="${cy + 4}" text-anchor="end">${esc(short)}</text>
        <rect class="band" x="${xs(r.estRange[0])}" y="${cy - 5}" width="${Math.max(2, xs(r.estRange[1]) - xs(r.estRange[0]))}" height="10" rx="4"/>
        <circle class="pt ${f}" cx="${xs(r.tokensM)}" cy="${cy}" r="5"/>
        <text x="${W - pad.r + 8}" y="${cy + 4}">${FIT_IC[f]} ${esc(f === 'in' ? (narrow ? '' : t('fit_in')) : (d > 0 ? '+' : '') + fmtN(Math.round(d * 10) / 10))}</text></g>`;
    });
    el.innerHTML = s + '</svg>';
  }
  function drawCharts() {
    if (TAB !== 'history') return;
    const rows = measured();
    const c1 = document.getElementById('ch1'), c2 = document.getElementById('ch2'), c3 = document.getElementById('ch3');
    if (c1 && rows.length) columnsChart(c1, rows);
    if (c2 && rows.length) lineChart(c2, rows);
    if (c3) rangeChart(c3, rows);
  }

  // ---------- render and events ----------
  function render() {
    document.documentElement.lang = ui();
    document.getElementById('app-header').innerHTML = header();
    const page = document.getElementById('page');
    page.innerHTML = TAB === 'backlog' ? renderBacklog() : TAB === 'decisions' ? renderDecisions() : TAB === 'history' ? renderHistory() : renderRoadmap();
    if (TAB === 'history') requestAnimationFrame(drawCharts);
  }
  function refreshGroups() {
    const g = TAB === 'backlog' ? groupsHtml() : decGroupsHtml();
    const el = document.getElementById('groups'), sh = document.getElementById('shown');
    if (el) el.innerHTML = g.html;
    if (sh) sh.textContent = g.shown;
  }
  const setTab = (k) => { if (!TABS.includes(k)) return; TAB = k; closeModal(); try { history.replaceState(null, '', '#' + k); } catch (e) { location.hash = k; } render(); window.scrollTo(0, 0); };

  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-close],[data-lang],[data-tab],[data-more],[data-type],[data-area],[data-range],[data-table],[data-all],[data-feed],[data-unit],[data-copy],[data-w],[data-open],[data-item],[data-pd]');
    if (!el) return;
    const ds = el.dataset;
    if (ds.close) return closeModal();
    if (ds.copy) return copyText(el, ds.copy);
    // Workplace switcher (and the names in the "Wszystkie" rows): kept across reloads like the other filters.
    if (ds.w) { wsel.w = ds.w; store.set('w', ds.w); return render(); }
    if (ds.feed) {
      LV.all = ds.feed === 'all'; store.set('feed', LV.all ? 'all' : 'ms'); lvApply(true);
      const b = document.querySelector(`#modal-wrap [data-feed="${ds.feed}"]`);
      if (b) b.focus({ preventScroll: true });
      return;
    }
    if (ds.unit) {
      // Redraw only the cost chart card: the page is not rendered again, the scroll position stays.
      u.unit = ds.unit === 'line' ? 'line' : 'file'; store.set('unit', u.unit);
      const card = document.getElementById('ch2card');
      if (card) {
        card.innerHTML = ch2Card();
        const c2 = document.getElementById('ch2'), rows = measured();
        if (c2 && rows.length) lineChart(c2, rows);
        const b = card.querySelector(`[data-unit="${u.unit}"]`);
        if (b) b.focus({ preventScroll: true });
      }
      return;
    }
    if (ds.lang) { LANG = ds.lang; store.set('lang', LANG); const id = document.getElementById('modal-wrap'); render(); if (id) closeModal(); return; }
    if (ds.tab) return setTab(ds.tab);
    if (ds.more) { ui0.more = !ui0.more; return render(); }
    if (ds.type) { u.types = u.types.includes(ds.type) ? u.types.filter((x) => x !== ds.type) : [...u.types, ds.type]; return render(); }
    if (ds.area !== undefined && el.classList.contains('fchip')) { u.area = u.area === ds.area ? '' : ds.area; return render(); }
    if (ds.range) { u.range = ds.range; return render(); }
    if (ds.table) { u.table = !u.table; return render(); }
    if (ds.all !== undefined) { u.all[ds.all] = true; return refreshGroups(); }
    e.stopPropagation();
    if (ds.open) return openSprint(ds.open);
    if (ds.item) return openItem(ds.item);
    if (ds.pd) return openDecision(ds.pd);
  });
  document.getElementById('overlay').addEventListener('click', () => closeModal());
  document.addEventListener('mousedown', (e) => { if (e.target.id === 'modal-wrap') closeModal(); });
  document.addEventListener('change', (e) => {
    const el = e.target;
    if (el.dataset.sel) { u[el.dataset.sel] = el.value; if (el.dataset.sel === 'group') { store.set('group', el.value); u.all = {}; } return render(); }
    if (el.dataset.check) { u[el.dataset.check] = el.checked; return render(); }
  });
  document.addEventListener('input', (e) => {
    if (e.target.id === 'q') { u.q = e.target.value; refreshGroups(); }
    if (e.target.id === 'dq') { u.dq = e.target.value; refreshGroups(); }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') return closeModal();
    if ((e.key === 'Enter' || e.key === ' ') && e.target.classList && e.target.classList.contains('bcard')) { e.preventDefault(); openSprint(e.target.dataset.open); }
  });
  window.addEventListener('hashchange', () => { const k = location.hash.slice(1); if (TABS.includes(k) && k !== TAB) setTab(k); });
  let rz = null;
  window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(drawCharts, 120); });

  // Tooltip: value first, label after; text only (textContent).
  const tipEl = document.getElementById('ttip');
  document.addEventListener('pointermove', (e) => {
    const g = e.target.closest && e.target.closest('[data-tip]');
    if (!g) { tipEl.style.display = 'none'; return; }
    let rows = [];
    try { rows = JSON.parse(g.getAttribute('data-tip')); } catch (err) { return; }
    tipEl.replaceChildren(...rows.map(([v, l], i) => { const d = document.createElement('div'); const a = document.createElement('span'); a.className = i === 0 ? 'v' : 'l'; a.textContent = v; d.appendChild(a);
      if (l) { const b = document.createElement('div'); b.className = 'l'; b.textContent = l; d.appendChild(b); } return d; }));
    tipEl.style.display = 'block';
    tipEl.style.left = Math.max(8, Math.min(e.clientX + 14, window.innerWidth - tipEl.offsetWidth - 8)) + 'px';
    tipEl.style.top = Math.min(e.clientY + 14, window.innerHeight - tipEl.offsetHeight - 8) + 'px';
  });
  window.DWMT_VIEW = { openSprint, setTab, data: D, live: { take: lvTake, apply: lvApply, state: () => LV, strings: T, put, isStale, indState, nowLine, card: lvCard, panel: (id) => { const s = sprintById(id); return s ? sprintPanel(s) : null; }, board: renderRoadmap },
    history: { html: renderHistory, kpis, table: histTable, chart: lineChart, columns: columnsChart, setUnit: (x) => { u.unit = x; } } };
  render();
  // Live: first poll at once, then every interval while the tab is visible; relative times tick every second.
  if (LIVE.enabled !== false) {
    document.addEventListener('visibilitychange', () => { if (document.hidden) clearTimeout(LV.timer); else lvPoll(); });
    setInterval(() => { try { lvApply(false); } catch (e) { /* keep the page usable */ } }, 1000);
    lvPoll();
  }
})();
