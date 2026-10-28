# dwmt (don't waste my time)

Lekki przebieg sprintu dla Claude Code:
- architekt (v2.7, `dwmt-architect`, `xhigh`) projektuje sprint: dokumenty i małe obszary kodu czyta sam, duże oddaje eksploratorom (`dwmt-explorer`, Opus `medium`, same fakty z dowodem, bez celu sprintu), pyta Cię raz, pisze `plan.md` (projekt `## Design`, pokrycie wejścia, zadania, kontrakty, AC sprintu, scenariusz UAT) i z góry plany wszystkich zadań (element–operacja z kotwicą `ścieżka#Symbol`, bez numerów linii); skrypt je waliduje;
- każde zadanie kończy się commitem na gałęzi sprintu i nową sesją; przed zadaniem k > 1 skrypt sprawdza rozjazd (uwagi wykonawców, zmiany poza planem, znikające pliki, zmiany celu) i tylko wtedy wzywa architekta (`replan`); pytania do Ciebie zadaje orkiestrator, planów nie czytasz;
- przed `finish` kontrola celu (`dwmt-checker`, bez kodu) porównuje wejście z raportami zadań; luki trafiają do raportu i na listę UAT;
- wykonawca (`single`) albo orkiestrator (`inline`, małe zmiany, sam też planuje);
- noc 2026-10-05: `direct` (bardzo małe poprawki wskazane w kodzie: bez planu, skrypt pisze plan zadania z pozycji, jeden `dwmt-executor-high` i recenzent, eskalacja do trybu z architektem) i prawdziwy `intermediate` (architekt bez eksploratorów, jedno zadanie, jedna recenzja); `finish --cleanup` odpina dowiązania (junction `node_modules`) przed `git worktree remove`;
- weryfikacja od ryzyk: testy wykonawcy jako dowody, recenzent sprawdza, czy dowodzą; jeden recenzent, a podział na jednostki po obszarach kodu tylko przy dużym diffie;
- czerwone testy celowane najpierw raz wracają do wykonawcy (naprawa), a komenda czerwona tylko raz (zielona w powtórce) jest oznaczana jako niestabilna i nie blokuje;
- weryfikacja UI (X7): przy ryzyku `ui` w briefie weryfikator (`dwmt-ui-verifier`) porównuje zrzuty z e2e z wyrenderowaną makietą;
- świeży fixer, który zaczyna od czerwonego testu;
- squash do gałęzi docelowej i raport końcowy z kontraktem (cel, kryteria z pokryciem przez zadania, decyzje, założenia, pokrycie ryzyk) i listą UAT;
- UAT (`/dwmt:uat`): lista z raportu, wstrzymanie scaleń na czas testu, zapis `uat.md` z wagą i klasą defektów, sprint poprawek, `uat-summary`;
- bramka ceny w `run` (D4): skrypt liczy cenę projektu z liczby plików w planie; sama nie dokłada tury pytań: pyta, gdy projekt przekracza szacunek 1,5× (albo próg `askAboveM`), a sprint bez szacunku dostaje pytanie o cenę tylko w turze pytań architekta, jeśli ta i tak jest;
- warstwa produktowa (D4, etap 1, wyłączalna): PO (`/dwmt:po`) prowadzi backlog, roadmapę, pliki sprintów i rejestr decyzji, a eksperci (`/dwmt:architect`, `/dwmt:ux`, `/dwmt:expert <dziedzina>`) to dodatkowe drzwi do rozmowy o jednej dziedzinie.

Mechanikę (stan, testy, diff, git) realizuje `scripts/dwmt.mjs` (Node, bez zależności), a prompty są krótkie (Z10). Prompty agentów i skilli są po angielsku. Od v2.8 artefakty agentów (plany, wyniki, recenzje, raporty) też są po angielsku; w języku z `language` (domyślnie `en`) są tylko rozmowa, pytania `Q-n`, kroki `## UAT`, tytuły decyzji `[visible]` i przyczyny luk kontroli celu. Specyfikacja dwmt i supervisora oraz notatki o faktach platformy to wewnętrzne dokumenty projektowe poza tym repozytorium.

## Instalacja

Wymagania: Claude Code ≥ 2.1.283, Node ≥ 22, git.

```text
/plugin install dwmt --marketplace korpal/dwmt
```

Aktualizacja: `/plugin marketplace update dwmt`. Do pracy nad samym pluginem: `claude --effort high --plugin-dir <klon>/dwmt`.

- Sesję zaczynaj z `--effort high`. Skille `run` i `execute` działają na `high`; `xhigh` mają agenci architekta i recenzenta (frontmatter z configu); effort ma każda rola, bo subagent bez `effort` dziedziczy effort sesji.
- **Uprawnienia:** skille mają `allowed-tools: Bash(node:*)`. W trybie ręcznej akceptacji dodaj regułę `Bash(node:*)` do `.claude/settings.local.json`, żeby nie potwierdzać każdego wywołania skryptu.

## Pierwsze uruchomienie w projekcie

1. W katalogu głównym repo uruchom `/dwmt:setup`. Tworzy `.claude/dwmt.json` (jeśli go nie ma; gałąź docelowa `git.target` z `origin/HEAD`, jedynej gałęzi albo znanej nazwy `main`/`master`/`develop`/`development`/`trunk`, a przy niepewnym wyborze setup pyta i zapisuje odpowiedź przez `setup --target <gałąź>` z zachowaniem komentarzy configu) i agentów `.claude/agents/dwmt-architect.md`, `dwmt-explorer.md`, `dwmt-executor.md`, `dwmt-executor-high.md`, `dwmt-reviewer.md`, `dwmt-reviewer-high.md` (v2.10: zmiany bez kodu) i `dwmt-checker.md` (oraz `dwmt-ui-verifier.md`, gdy config ma `ui`) z `model`, `effort` i `maxTurns` z configu. Stary `dwmt-planner.md` usuwa; klucz `roles.planner` w configu działa jako alias `architect` (z ostrzeżeniem).
2. Uzupełnij config (niżej) i uruchom `/dwmt:setup` ponownie.
3. Zacommituj `.claude/dwmt.json` i `.claude/agents/dwmt-*.md`. Preflight wymaga czystego drzewa.
4. Zrestartuj sesję. W E1 nowi agenci byli widoczni dopiero w nowej sesji; w E2 bywali widoczni od razu. Restart jest pewny.

## Config: `.claude/dwmt.json`

```jsonc
{
  "model": "opus",
  "language": "pl",                   // język użytkownika: rozmowa, pytania, kroki UAT (v2.8: artefakty agentów po angielsku)
  "roles": {
    "architect":     { "effort": "xhigh",  "maxTurns": 200 },   // v2.7; stary klucz planner = alias
    "explorer":      { "model": "opus", "effort": "medium", "maxTurns": 100 },   // mikrosonda D3: w naszej sondzie Sonnet zmyślał pola kontraktu
    "checker":       { "effort": "medium", "maxTurns": 40 },    // kontrola celu przed finish
    "executor":      { "effort": "medium", "maxTurns": 100 },   // krótkie odcinki; kontynuacja od progress.md
    "executor-high": { "from": "executor", "effort": "high" },
    "reviewer":      { "effort": "xhigh",  "maxTurns": 200 },   // jeden recenzent na całą zmianę
    "reviewer-high": { "from": "reviewer", "effort": "high" },  // v2.10: zmiana bez plików kodu (review.docsGlobs)
    "ui-verifier":   { "effort": "xhigh",  "maxTurns": 80 }   // tylko z kluczem ui
  },
  "explore": { "selfReadMaxK": 30, "maxRounds": 3 }, // obszar do 30k tokenów (sizes.txt) architekt czyta sam; rundy z jednym eksploratorem
  "plan": { "taskPlanMaxKB": 10 },   // K4 (reguły 2.11): plan zadania po autopoprawkach najwyżej 10 KB, większy wraca do architekta z powodem
  "review": {
    "maxRounds": 2, "maxRiskLenses": 2,
    "lensGlobs": { "security": ["**/auth/**"], "data": ["**/db/migration/**"], "ui": ["frontend/**"] },
    "splitAboveK": 150,               // szacunek recenzji z diffu (tys. tokenów = bajty patcha / 4); powyżej: jednostki po obszarach z briefu
    "ignoreGlobs": [],                // pliki generowane (np. "frontend/src/api/generated/**"): poza szacunkiem i diffem recenzenta
    "secondLookCritical": false,      // opcja: ryzyko critical dostaje dodatkową jednostkę „drugie spojrzenie” (sprint 3: 0,5 mln, 0 poprawek)
    "deferredFile": ".dwmt/deferred.md", // zbiorczy plik odłożonych uwag (dopisywany przy finish, tylko bez warstwy produktowej; z nią `product intake` robi pozycje backlogu); plik śledzony przez git idzie w squashu; null wyłącza
    "batch": true,                    // v2.8: runda zbiorcza po ostatnim zadaniu; false = poprawki w każdym zadaniu jak w v2.7
    "docsOnlyRole": "reviewer-high",  // v2.10: rola recenzenta, gdy każdy zmieniony plik pasuje do docsGlobs; null = zawsze reviewer
    "docsGlobs": ["**/*.md", "**/*.mdx", "**/*.rst", "**/*.adoc"]
  },
  "verify": {
    "targeted": null,                 // dokładane w każdej rundzie do komend verify z briefu (strażnicy projektu)
    "full": ["npm test"],             // pełna suita przy finish (po rebase); zawsze przez kolejkę maszyny
    "heavy": null,                    // regex komend ciężkich w rundach (np. "e2e|with-env"): czekają w kolejce maszyny
    "rerunRed": true,                 // czerwona komenda biegnie drugi raz; zielona za drugim razem = flaky (nie blokuje)
    "rerunFailedIndividually": false, // opcjonalnie: powtórka czerwonych plików
    "rerunCmd": "node --test {file}", "failedFileRegex": "not ok \\d+ - (\\S+\\.test\\.mjs)",
    "testFiles": null,                // kt: glob argumentów-plików testów (np. "dwmt/test/*.test.mjs"): rundy poprawek i naprawy powtarzają tylko czerwone albo zmienione pliki testów, zielone komendy przenoszą wynik; null = na poziomie komend
    "shell": null,                    // powłoka komend verify, np. "C:/Program Files/Git/bin/bash.exe"; null = cmd.exe na Windows, /bin/sh gdzie indziej
    "ports": [{ "for": "e2e", "ports": [5173] }], // v2.10: porty ciężkich komend; zajęty przez inny proces → wynik `env` z PID i linią polecenia (nic nie rusza)
    "e2eChanged": { "glob": "frontend/e2e/**/*.spec.ts", "cmd": "npm --prefix frontend run test:e2e -- {files}", "strip": "frontend/" }, // noc 2026-10-05: e2e dodane albo zmienione przez sprint biegną przy finish (stare nie); null = bez e2e
    "unit": [{ "glob": "frontend/src/**", "cmd": "npm --prefix frontend run test --" }] // 2026-10-09: zadanie zmieniające plik z glob ma w verify komendę od cmd (testy jednostkowe obszaru; walidacja planu)
  },
  "env": {                            // środowisko przed verify i finish; niegotowe = wynik `env` (pytanie do Ciebie), nie czerwień
    "checks": [{ "cmd": "docker compose ps --status running -q | grep -q .", "hint": "uruchom docker compose up -d", "for": "with-env|e2e", "up": "docker compose up -d" }]
  },                                  // `for`: regex komend, które go potrzebują (bez niego zawsze); `up`: uruchamiane raz przy niegotowym (zgodą jest wpis); preflight pokazuje niegotowe jako ostrzeżenia
  "scriptChecks": { "enabled": true }, // 2.11: po każdym kroku wykonawcy skrypt sprawdza pliki poza zakresem bez powodu, usunięte/osłabione asercje i dodane skip/only; trafienie raz wraca do wykonawcy, potem uwaga major w recenzji; false wyłącza
  "uat": {                            // lista UAT w raporcie sprintu i wstrzymanie scaleń na czas UAT
    "start": ["npm --prefix desktop run dev"], // komendy startu aplikacji dla Ciebie (np. "docker compose up --build -d" i restart kontenera frontendu); skill UAT ich nie uruchamia
    "notes": ["błąd Flyway: reset bazy"], "holdMaxMin": 240
  },
  "launch": { "permissionMode": "auto" }, // tryb sesji następczyni po zadaniu (`dwmt launch`, nazwa `dwmt <przebieg> · T-k/N`); null = domyślny tryb użytkownika
  "drive": { "enabled": true, "permissionMode": null, "agentTimeoutMin": 240, "maxTurnRestarts": 5, "finishRepair": true, "agentSessions": "background" }, // v3 (N-2): sterownik `drive.mjs` prowadzi sprint zamiast orkiestratora LLM; K4: domyślnie włączony (projekt bez własnego `drive.enabled` dostaje przy pierwszym `init` jednorazowy komunikat `notice`, znacznik `.dwmt/drive-default-noted.json` w głównym drzewie); false = powrót do sesji modelu (v2.10 bez zmian); tryb `inline` zawsze sesją modelu; 2026-10-09: `--max-turns` z roli (maxTurnRestarts świeżych odcinków wykonawcy na rundę), jedna naprawa przy finish (finishRepair: false wyłącza); K4: `agentSessions` `background` = agenci jako sesje `claude --bg` widoczne w `claude agents`, `headless` = ukryty `claude -p`
  "watch": { "intervalSec": 30, "idleMin": 30, "hangMin": 90 }, // v2.10: `dwmt watch` (przestój = nikt nie żyje; zawieszenie = żywy proces bez przyrostu przez hangMin)
  "supervisor": { "hotFiles": [] },   // pliki wspólne sprintów zlecenia, podawane architektowi (pole `shared`); S3: enabled, intervalSec 30, stallGraceMin 5, hangMaxMin 240, stallRestarts 1, limitMarginMin 2, phonePush true (sesja Haiku ok. 0,01–0,02 mln na push), keepAwake true, autostart false (do S4), typicalCostM 15
  "ui": {                             // opcjonalnie (X7); bez niego brak ryzyk `ui` i weryfikatora
    "shots": "frontend/test-results/screens", // gdzie e2e zapisuje zrzuty (kopiowane po każdej komendzie verify)
    "playwright": "frontend",         // katalog, z którego rozwiązuje się @playwright/test do renderu makiet
    "viewport": [1440, 900],          // viewport renderu makiety, taki jak zrzutów
    "mockupCss": "#variant-nav{display:none!important}", // CSS wstrzykiwany do makiety przed zrzutem
    "maxPairs": 6                     // par obraz–makieta na jednostkę weryfikatora
  },
  "git": {
    "branchPrefix": "dwmt/", "finish": "squash", "target": "develop", // bez klucza: origin/HEAD, potem pierwsza istniejąca z main, master, develop, development, trunk
    "rebase": "finish"                // finish (przy zakończeniu) | review (przed pierwszą recenzją, z commitem roboczym) | none
  },
  "agentsScope": "project",
  "guard": { "scope": "run" },        // zakres strażnika komend destrukcyjnych: run | repo | always; env DWMT_GUARD_SCOPE wygrywa; czyta go sam hook
  "run": { "priceGate": { "askAboveM": null } }, // D4: bramka ceny w run (false = zachowanie v2.10; askAboveM: próg mln, ponad którym pyta zawsze)
  "product": {                        // D4: warstwa produktowa; bez tego klucza i bez katalogu warstwy nie ma
    "dir": "docs/product", "enabled": true, "contextWarnK": 150,
    "start": { "smallMaxK": 30, "smallMaxM": 1.0 },
    "price": { "explorerM": [0.24, 0.86], "defaultMPerFile": { "direct": 0.05, "inline": 0.1, "intermediate": 0.15, "single": 0.2 } },
    // strona dla człowieka (§3.11): odświeżanie po commit/sync/brief/intake, tłumaczenia tytułów w tle po `product commit` (language ≠ en),
    // tani model tłumaczeń i szkiców `for-you --draft`, limity czasu wywołań; `publish`: strona w repo, commitowana z produktem
    // (bez klucza: `<dir>/roadmap.html`; null = strona tylko w `.dwmt/product/view/index.html`, poza gitem)
    "view": { "enabled": true, "translate": true, "model": "haiku", "draftTimeoutS": 180, "translateTimeoutS": 120, "publish": "docs/product/roadmap.html" }
  }
}
```

Zamykające verify (kt): zanim zadanie albo runda zbiorcza dostanie commit (PASS, puste `now` albo `commit --accept`), cała lista `verify` biegnie jeszcze raz, jeśli drzewo zmieniło się od ostatniego pełnego verify; czerwone dostaje jedną naprawę rundy, potem pytanie (akceptacja z czerwienią albo stop).

Pominięte klucze biorą wartości domyślne (powyżej). Zmiana `model`, `roles` albo szablonów agentów wymaga ponownego `/dwmt:setup`; preflight to wykrywa.

## Polecenia

| Polecenie | Co robi |
|---|---|
| `/dwmt:run <zadanie> [--mode auto\|direct\|inline\|intermediate\|single]` | Preflight, gałąź i katalog przebiegu, `task.md`; architekt (albo orkiestrator w `inline`) pisze plan i plany wszystkich zadań, pytania idą do Ciebie przez AskUserQuestion, potem `execute` w tej samej turze |
| `/dwmt:run <ścieżka .md>` | Gotowy plan zadania dwmt (bez architekta, chyba że ma otwarte `questions`), zapis UAT `uat.md` (sprint poprawek otwartych defektów) albo plik z treścią zadania |
| `/dwmt:run --sprint <id>` | Wejście od supervisora: `<główne drzewo>/.dwmt/supervisor/input/<id>.md` (kolejność zlecenia, `after`, bramka UAT); status dla pętli w `.dwmt/supervisor/status/<id>.json` |
| `/dwmt:execute <run-id>` | Wznowienie po przerwie, `/clear` albo w nowej sesji; kolejne zadanie sprintu w nowej sesji (`dwmt launch` robi to w tle). Stan jest w plikach |
| `/dwmt:uat [<sprint>…] [--late]` | UAT scalonych sprintów: lista czekających, wstrzymanie scaleń, lista UAT z raportu, zapis wyniku z klasą defektów, polecenie sprintu poprawek |
| `/dwmt:setup` | Generuje agentów z configu |
| `/dwmt:run <product.dir>/sprints/<id>.md` | Plik sprintu warstwy produktowej: `task.md` z `dwmt product sprint <id>` (linia roadmapy, plik, rozwinięte pozycje i `PD-n`), `run.spec`, tryb i szacunek z nagłówka; sprint nie `ready`/`ordered` tylko po Twojej zgodzie (`init --force`) |
| `/dwmt:run --item B-1,B-2 [--mode direct\|inline]` | Zadanie z pozycji backlogu (bez pliku sprintu); `sync` zamyka pozycje po scaleniu |
| `/dwmt:run … --estimate <min,max> [--mode intermediate]` | Cena przyjęta przy starcie (mln tokenów) jako szacunek dla bramki ceny; `intermediate` to `single` z etykietą `modeLabel` do cen i statystyk |
| `/dwmt:po [tekst]` | PO: pomysły, błędy, triaż, „robimy sprint X”, refinement, „co dalej?”, start pracy z trybem i ceną, wykonanie (supervisor albo `init` + `launch`), UAT; pliki produktu zmienia tylko skrypt |
| `/dwmt:expert <dziedzina> [tekst]`, `/dwmt:architect`, `/dwmt:ux` | Drzwi eksperta (plik eksperta: wbudowani `dwmt/experts/`, projektu `<product.dir>/experts/`); cena przed eksploratorami, decyzje do rejestru tylko po Twoim potwierdzeniu jedną linią; UX w etapie 1 tylko rozmawia |

**Sterownik (K4: domyślnie):** po planie sprint prowadzi skrypt `drive.mjs --detach`, a sesja `/dwmt:run`/`/dwmt:execute` tylko czeka (`dwmt wait`) i obsługuje pytania i zatrzymania. Tryb `inline` i projekt z `"drive": {"enabled": false}` prowadzi sesja modelu jak w v2.10.

**Agenci sterownika w `claude agents` (K4):** każdy agent (architekt, wykonawca, recenzent, kontrola celu, naprawa przy finish) to sesja Claude w tle o nazwie `dwmt <sprint> · T-k rN · <krok> · <rola>`, np. `dwmt k5 · T-2 r1 · implement · wykonawca`. `claude agents` w terminalu pokazuje, kto nad czym pracuje; `claude attach <id>` otwiera sesję (wyjście z widoku jej nie zatrzymuje), a agent czekający na zgodę daje linię `claude attach <id>` w `drive.log` i zdarzenie `agent-waiting`. Po kroku sesja znika z listy (`claude stop` + `claude rm`). Gdy start w tle się nie uda (np. katalog, w którym nigdy nie uruchomiono `claude` i nie zaakceptowano zaufania), ten agent rusza ukryty (`claude -p`) z linią `background start failed`; `"drive": {"agentSessions": "headless"}` przywraca tryb ukryty dla wszystkich.

**Gałęzie:**
- Na gałęzi docelowej przebieg tworzy `dwmt/<run-id>`.
- Na każdej innej gałęzi (sprint, worktree) pracuje na miejscu.
- `finish` (raz na sprint, po commicie ostatniego zadania) robi rebase na gałąź docelową (chyba że `git.rebase: none`; przy `review` rebase był już przed pierwszą recenzją), pełną suitę, `final-report.md` i squash przez `git -C <drzewo docelowe>` (albo `leave` z configu).
- **`merge-wait`:** squash nie wchodzi, gdy trwa Twój UAT (bilet `/dwmt:uat`), drzewo docelowe ma zmiany w plikach śledzonych albo nieśledzone pliki tam, gdzie squash dodaje pliki, albo główne drzewo stoi na innej gałęzi. `finish` zwalnia wtedy blokadę scalania i kończy; ponowny `finish` (`/dwmt:execute <run>`) robi squash bez pełnej suity, jeśli cel się nie zmienił. Nieśledzone pliki, których squash nie dotyka, nie blokują; zmiany w katalogu produktu (`product.dir`) też nie.
- **Kopia w głównym drzewie:** przy squashu, `leave` i `merge-wait` `run.json`, `final-report.md`, `plan.md`, `task.md`, `answers.md`, `goal-check.md`, raporty zadań i `ui/` trafiają do `<główne drzewo>/.dwmt/runs/<run>/` (tam też `uat.md`). Z warstwą produktową `finish` woła potem `dwmt product intake <run>` (błąd tylko ostrzega, pole `intake`): po squashu albo `leave` z `--sync`, więc linia roadmapy, pozycje, nagłówek sprintu i opublikowana strona zmieniają się w tym samym commicie produktu `product: intake <run>` (pole `intake.synced` wylicza zmiany); w `merge-wait` z `--no-commit` i bez synchronizacji. Błąd synchronizacji to tylko ostrzeżenie (`sync: …` w `intake.warnings`).
- Czerwona pełna suita daje `red`. Po poprawce ponowny `finish` powtarza tylko czerwone komendy (ta sama baza). Znaną czerwień możesz przyjąć: `finish --accept-red` (trafia do raportu). Jeśli po `red` scaliłeś ręcznie, `finish` to rozpozna i zamknie przebieg.
- Gałąź usuwa dopiero `finish --cleanup` po Twojej zgodzie. Worktree usuwasz ręcznie.

**Przerwanie:** nie przerywaj (Esc), gdy agent pracuje w tle („Waiting for background agent”). Poczekaj na jego wynik, bo inaczej wznowienie może uruchomić drugiego wykonawcę.

## Skrypt `scripts/dwmt.mjs`

Skille wywołują go jako `node "${CLAUDE_PLUGIN_ROOT}/scripts/dwmt.mjs" <komenda>`. Każda komenda wypisuje JSON o długości najwyżej 20 linii.

| Komenda | Działanie |
|---|---|
| `setup [--check] [--target <gałąź>]` | render agentów z configu (zachowuje EOL), `--check` tylko porównuje; `target`, `targetSource`, `targetQuestion` (wybór niepewny albo gałąź z configu nie istnieje); `--target` zapisuje `git.target` w configu |
| `preflight --slug <s>` | tylko odczyt: czystość, gałąź, agenci, ostrzeżenie o bazie, proponowany `run` |
| `init --run <id> [--mode m] [--input plik] [--sprint id] [--worktree]` | gałąź, `.dwmt/runs/<id>/run.json`, wpis `.dwmt/` w `.git/info/exclude`; wejście: brief (import do `tasks/1/brief.md`), `uat.md` (sprint poprawek, `source`), plik zadania, wejście supervisora; wynik `kind`, `brief`, `dir`. `--worktree`: przebieg we własnym worktree `supervisor.worktreeDir/<id>` (domyślnie `.claude/worktrees/`, z HEAD; kopia `.claude/dwmt.json`, `settings.local.json` i agentów, komendy `supervisor.worktreeSetup`), główne drzewo bez zmian. Odmowa przy niezacommitowanym katalogu produktu (`dwmt product commit`) i na gałęzi importu produktu |
| `import-plan <plik> --run <id>` | kopiuje gotowy brief do katalogu bieżącego zadania i waliduje (nagłówek, sekcje `R-n` i `Q-n`, AC z planu, `## UAT` bez planu) |
| `header <plik> [--check]`, `section <plik> <ID albo tytuł>` | nagłówek YAML jako JSON; sekcja `Q-n`/`F-n`/`D-n` albo po dokładnym tytule (`UAT` w raporcie) |
| `state <run>` | następny krok (`next`: `plan` z `key` i `fresh` architekta, `ask-plan`, `planned`, `replan` z przyczynami rozjazdu, `implement`, …, `review` z `units`, `commit`, `handoff`, `goal-check`, `finish`, `done`), zadanie `task`/`tasks`, katalog zadania `dir`, agent i gotowy prompt; `limit` (agent trafiony limitem abonamentu), `second` (to dwa sprinty); scala recenzje jednostek; pod supervisorem zapisuje status |
| `replan-done <run> <k> --result changed\|unchanged [--cause plan\|discovery\|target]` | po odpowiedzi architekta na `replan`: waliduje plany od `T-k` i zapisuje obsłużone przyczyny w `run.json` (ta sama nie wraca); przy `planIssue` zdejmuje blokadę zadania |
| `launch <run>` | sesja następczyni po zadaniu: `claude --bg … "/dwmt:execute <run>"` w drzewie przebiegu (bez shella, `bgIsolation: none`; przebieg z `init --worktree` znajduje w jego worktree), wynik `id` i `claude attach <id>` |
| `status <run> <stan> [--reason t]` | status ręczny dla supervisora (np. `stopped`) |
| `delete-consent <run> --yes\|--no` | v2.10: zgoda na usunięcie plików z nagłówków `delete` planów (krok `ask-delete`); skrypt usuwa je na starcie ich zadania, bez zgody zostają (kryterium niespełnione w raporcie) |
| `watch <run> [--interval s] [--once] [--follow]` | v2.10: alarm przestoju, w tle obok `verify`/`finish` (bez `--follow` kończy, gdy obserwowana komenda się skończyła albo krok przebiegu się zmienił): cisza, póki żyje proces komendy (`active.json` z czasem startu procesu, bilety kolejki) i coś przyrasta (przy komendzie: jej rekord, bilet i transkrypty agentów, bez głównego transkryptu; bilet czekający w kolejce to praca), a w kroku agenta transkrypty i pliki przebiegu; przy przestoju albo zawieszeniu jedna linia i zdarzenie `stall` |
| `wait <run> [--interval s] [--progress [--after ts]]` | N-2 (sterownik): sesja sprintu czeka w tle (bez limitu czasu); jedna linia JSON `{status, reason}`, gdy przebieg jej potrzebuje: `drive-stop` tego przebiegu (`done`, `waiting-user`, `stopped`, `hold`), śmierć sterownika bez zdarzenia końca (`dead`, zdarzenie `stall` `driver-dead`), zawieszenie komendy (`hang`), brak sterownika (`not-running`) |
| `drive-mode <run> on\|off`, `drive-log <run> [--lines n]` | Tryb A (2026-10-04): `off` wyłącza sterownik dla przebiegu (`state` bez `drive`; sesja dokańcza pętlę sama, np. po błędzie sterownika; odmowa, gdy sterownik żyje); `drive-log` to ostatnie linie `drive.log` na pytanie „status?”. `--progress` w `wait`: linia `{status: progress, reason, at}` przy starcie i końcu zadania (z `events.jsonl`), kolejna z `--after <at>`. Komendy przebiegu wołane z głównego drzewa trafiają do worktree przebiegu (`init --worktree`). |
| `stop <run>` | recenzja N-2: zatrzymuje zawieszoną komendę przebiegu (PID z `active.json`, z potomkami) po linii `hang`; sterownik kończy się `stopped` (`child-dead`) |
| `sessions-add <run> <sesja…>` | v3: sesje agentów sterownika do `run.json` (koszt w raporcie, kopia `explore/`) |
| `uat list [--all]`, `uat start <id…>`, `uat record <id…> <plik.json> [--late]`, `uat release`, `uat-summary` | UAT (`scripts/uat.mjs`): sprinty czekające i w `merge-wait`, bilet wstrzymania `~/.dwmt/holds/`, zapis `uat.md` i zdarzenia `status/<id>.uat.json`, tabela przepuszczonych defektów i kosztu łącznego (`.dwmt/uat-summary.md`) |
| `verify <run> [--full]`, `diff <run>`, `review-input <run>` | testy do `tests.md` (przy `git.rebase: review` najpierw commit roboczy i rebase; czerwona komenda biegnie drugi raz, pierwsza czerwień rundy daje `repair: true`), `diff.patch` (i `fix-delta.patch`: tylko pliki w `scope` i zgłoszone w `outOfScopeChanges`, bez warstwy produktowej; `diff` podaje liczby `outside` i `product`), wejście recenzji (z nazwami plików spoza diffu): przejście `risks` z dowodami wykonawcy, perspektywy, jednostki, zmiany komend `verify` |
| `heavy [--shell s] [--who opis] -- <komenda…>`, `queue` | komenda w kolejce maszyny (wyjście i kod komendy, bez JSON); stan kolejki i blokad scalania |
| `commit <run> [--accept]`, `finish <run> [--accept-red\|--accept-deferred\|--fixed-deferred\|--cleanup]`, `extend <run>`, `unblock <run>` | commit zadania po PASS (`T-k <tytuł>`, raport zadania, przy k < N przekazanie sesji), zakończenie sprintu, dodatkowa runda, odblokowanie po decyzji |

## Artefakty: `.dwmt/runs/<run-id>/`

- `run.json`: stan sprintu (tryb, gałęzie, zadanie bieżące, `handoff`, `sprint`, `source`, `finish`, `session_ids`) i stan zadań w `tasks[]` (baseline, drzewa rund, znaczniki, commit, sesje);
- `task.md`: zadanie dosłownie; `answers.md`: Twoje odpowiedzi na `Q-n` sprintu; `sizes.txt`: szacunek tokenów na katalog (dla reguły obszaru architekta);
- `plan.md`: plan sprintu (`## Design`, `## Input coverage`, zadania `T-k` z `Depends`, kontrakty `C-n`, AC sprintu, scenariusz UAT); przy architekcie zawsze, także przy jednym zadaniu;
- `explore/`: odpowiedzi eksploratorów (`<obszar>-r<N>.md`), kopiowane z transkryptów przez `state`, best effort;
- `goal-check.md`: kontrola celu przed `finish` (`gaps`);
- `tasks/<k>/`: artefakty zadania k (poniżej) i `report.md` przy jego commicie (z uwagami dla kolejnych zadań); `answers.md` na pytania z `replan` albo BLOCKED;
- `brief.md`: plan zadania od architekta (cel, `AC-n`, `read_first`, `## Changes` element–operacja, kontrakty, `D-n` z treścią, `A-n`, `R-n`, obszary, wyciągi; bez numerów linii; w `inline` i przy imporcie także `## UAT`);
- `progress.md`: dopisywany przez wykonawcę;
- `result-N.md`: nagłówek wyniku rundy; `repair-N.md`: wynik naprawy czerwonych testów (`unrelatedRed`: czerwień, której zmiana nie spowodowała);
- `tests.md`, `tests-full.md`: wyniki testów;
- `diff.patch`, `fix-delta.patch`: tylko pliki w `scope` planu zadania (runda zbiorcza: suma zakresów zadań) i zgłoszone w `outOfScopeChanges`; pozostałe zmienione pliki wejście recenzji wymienia po nazwie, a katalog `product.dir` i strony `product.view.publish` nie ma w nich nigdy; `diff-review.patch` (bez plików z `review.ignoreGlobs`);
- `review-input.md`, `review-N.md`; przy podziale `review-input-<u>.md`, `diff-<u>.patch`, `review-1-<u>.md` i scalone `review-1.md`; od reguł 2.11 z planem sprintu (K4) wejście recenzji jest samowystarczalne: kryteria, decyzje i kontrakty z ich właściciela (`plan.md` albo plan zadania), zakres, „poza zakresem” i wyciągi, bez pola `brief` i bez ścieżki planu zadania (w rundzie zbiorczej bez linii `- Task plan:`);
- `ui/`: `r<N>/` zrzuty rundy, `mockup-R-n.png`, `pairs-r<N>.json`, `compare.html` (makieta obok zrzutu ze statusem ryzyka; `finish` kopiuje `ui/` do archiwum w drzewie docelowym);
- `tests-full.md`, `final-report.md` (w katalogu przebiegu: kontrakt, tabela zadań, pokrycie AC, ryzyka z przedrostkiem `T-k/`, sekcja `## UAT`, `uat: pending | n/a`; od 2.11 z planem sprintu każde kryterium i każda decyzja sprintu raz, w `## Contract`, a części zadań podają decyzje sprintu po identyfikatorze: `- T-k sprint decisions: D-1, D-6`);
- `uat.md` (kopia w głównym drzewie): wpisy UAT i `late`, defekty `U-n` z wagą, rodzajem, klasą i sprintem poprawek.

Przebiegi sprzed v2.6 (płaski katalog) dalej dają się czytać.

Schematy nagłówków są w `schemas/headers.json`.

**Pomiar:** `final-report.md` ma w nagłówku `cost` (mln tokenów ekwiwalentu inputu, łącznie i według ról, liczone z transkryptów w chwili raportu; końcówka sesji po `finish` nie wchodzi). `by-sprint` ma osobny tor `dwmt`.

**Odłożone uwagi:** `finish` dopisuje uwagi `defer` z recenzji (nagłówek, powód, miejsce) do `review.deferredFile`, sekcja na przebieg. Z warstwą produktową obecną i włączoną pliku nie ma: `product intake` robi z tych uwag pozycje backlogu (`remark`); gdy intake się nie uda, ostrzeżenie podaje komendę `dwmt product intake <run> --sync` do ponowienia (w `merge-wait`: `dwmt product intake <run> --no-commit`).
**Bramka uwag major:** odłożone uwagi o wadze `major` albo `blocker`, wciąż otwarte po rundzie zbiorczej, zatrzymują `finish` przed rebase'em ze statusem `deferred-major` (lista `majors`, czekanie na Ciebie, także pod driverem i supervisorem). `finish --accept-deferred` zapisuje przyjęcie w `run.json` (`deferredAccepted`) i scala; raport oznacza takie uwagi „(accepted by the user <data>)”, a nagłówek ma `acceptedDeferred`. Jeśli wolisz je poprawić przed scaleniem: popraw na gałęzi przebiegu, zrób commit i uruchom `finish --fixed-deferred` (odmawia bez nowego commita od zatrzymania); uwagi znikają z odłożonych (nie trafiają do pliku ani do backlogu), a raport wymienia je linią „Fixed by you after the reviews (not re-reviewed)” i w nagłówku `fixedDeferred`. Kolejny `finish` staje tylko na uwagach jeszcze nieprzyjętych i niepoprawionych; uwagi `minor` nigdy go nie zatrzymują.

## Kolejka maszyny (S1a)

Ciężkie komendy wszystkich projektów na tej maszynie idą po kolei (specyfikacja supervisora §7):
- **`verify`:** komendy pasujące do `verify.heavy` czekają w kolejce (każda osobno, z powtórką czerwieni w tej samej dzierżawie); pełna suita w `finish` zawsze, jako całość. Czas w kolejce: `queueMs` w `tests.md`, `queue` w wyniku.
- **`finish`:** blokada scalania na repo (wspólny katalog git, także z worktree) i gałąź docelową, od rebase do squasha; drugi `finish` czeka (`mergeWaitMs`), potem robi rebase na świeży cel.
- **Twoje komendy:** `dwmt heavy -- mvn verify` (katalog `bin` w PATH). Z PowerShell i cmd komenda biegnie w cmd.exe, z Git Bash w bashu. Projekt może wpiąć nakładkę w skrypty (np. `e2e.sh`, `with-env.sh mvn` albo `npm run test:e2e` przez `scripts/heavy.mjs`). Zagnieżdżone wywołanie (`DWMT_HEAVY` w środowisku, np. `e2e.sh` z `verify`) nie czeka drugi raz.
- **Stan:** `~/.dwmt/`: `machine.json` (`heavySlots` domyślnie 1, `staleAfterMin` 240, `pollMs`; reszta dla supervisora), `locks/<klucz>/` (bilet = plik z pid, kolejność FIFO), `queue.log` (JSON na linię: kto, co, od kiedy do kiedy, ile czekał, kod). `dwmt queue` pokazuje, kto biegnie i kto czeka.
- **Martwe blokady:** bilet procesu, który nie żyje, albo starszy niż `staleAfterMin` (PID bywa użyty ponownie) usuwa następny czekający i zapisuje to w `queue.log`. Ctrl+C w trakcie czekania zostawia bilet martwego procesu; sprząta go następny.
- **PATH (raz):** `[Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path','User') + ';<klon>\dwmt\bin', 'User')` i nowy terminal. Bez `dwmt` w PATH wpięte skrypty projektów uruchamiają komendę wprost, z ostrzeżeniem.

## Weryfikacja UI (X7)

- **Kiedy:** plan zadania ma ryzyko z `Method: ui` (architekt dodaje je w zadaniu, które zmienia ekran, gdy config ma `ui` i ekran ma uzgodnioną makietę). Ryzyko ma linie `Mockup:` (html albo png), opcjonalnie `Mockup-state:` (JS, który w makiecie pokazuje wariant i stan, np. `document.querySelectorAll('.variant-tab')[1].click()`) i `Shot:` (nazwa zrzutu; pasuje `nazwa.png` i `nazwa-*.png`).
- **Zrzut:** wykonawca pisze test e2e, który otwiera ekran w stanie z ryzyka i robi zrzut helperem projektu. Komenda e2e jest w `verify` briefu. Brak zrzutu po `verify` to czerwona pseudo-komenda `dwmt ui: screenshots`.
- **Makieta:** `scripts/render-mockup.mjs` renderuje html przez Playwright projektu (`ui.playwright`) w `ui.viewport`, z `ui.mockupCss` i `Mockup-state`. Błąd renderu nie czerwieni rundy; orkiestrator mówi o nim jednym zdaniem.
- **Ocena:** jednostka recenzji `ui` (agent `dwmt-ui-verifier`, perspektywy `visual` i `pragmatism`) działa równolegle z recenzentem kodu, tylko dla par zrzut + makieta (ryzyko bez zrzutu nie idzie do weryfikatora). Wynik scala się jak jednostki recenzji; poprawki idą przez zwykłą rundę fix. W rechecku uwagi z jednostki `ui` i ryzyka `ui` bez `proven` wracają do weryfikatora na nowych zrzutach.
- **Dla Ciebie:** `ui/compare.html` w katalogu przebiegu i link w `final-report.md`. Przebieg nie czeka na Twoją ocenę (decyzja 2026-09-28).
- **Maszyna:** komendy `verify` (także e2e) idą po kolei, nigdy równolegle; e2e w każdej rundzie kosztuje czas, więc architekt wybiera najwęższy spec.

## Sprint z zadaniami i UAT (v2.6)

- **Zadania:** architekt dzieli sprint według wspólnego zbioru do przeczytania (do ok. 90k na zadanie) i kontraktów, nie według warstw; zadanie k przechodzi pełny przebieg w `tasks/<k>/` z diffem od commitu zadania k−1; recenzent widzi sekcję „Sprint” (zadania późniejsze, kontrakty).
- **Rozjazd (v2.7):** przed zadaniem k > 1 skrypt porównuje plan zadania z raportami poprzednich (`laterNotes`, `changedContracts` z kotwicą, niespełnione AC zależności), z plikami na HEAD i, przy `git.rebase: review`, ze zmianami celu. Przy rozjeździe świeży architekt poprawia plany od k (`replan`), a `replan-done` zapisuje przyczyny jako obsłużone. Wykonawca, który uzna plan za błędny, kończy `BLOCKED` z `planIssue`: sprawa idzie do architekta, nie do Ciebie.
- **Przebiegi sprzed v2.7** (bez `rules` w `run.json`) kończą się regułami v2.6; rolę planistów pełni `dwmt-architect`. Przebiegi z `rules: 2.7` kończą się regułami v2.7.
- **Runda zbiorcza (v2.8, `review.batch`):** po recenzji zadania k skrypt dzieli listę `fix`: od razu (`now`) tylko blocker i uwaga, której plik z dowodu leży w kotwicach albo `scope` późniejszego zadania; reszta, odłożone uwagi widoczne dla użytkownika (`visible` recenzenta, każda uwaga jednostki `ui`) i uwagi otwarte po ostatniej rundzie idą do `run.json` (`batch.items`, `T-k/F-n`). Po ostatnim zadaniu, przed kontrolą celu, `state` zwraca `batch`: `batch/batch.md`, jeden `dwmt-executor-high`, verify (suma komend zadań pozycji), recheck, commit i `batch/report.md`; raport końcowy ma `## Fix batch`. Nie w `inline` i przy imporcie planu zadania bez `plan.md`.
- **v2.9 (po sprintach 6+7):** skrypt sam kopiuje `C-n` i `D-n` planu sprintu do planów zadań i rozwija jednoznaczne skróty ścieżek (`autofixed` w `state`); hook `PostToolUse` (`hooks/plan-check.mjs`) sprawdza plan zaraz po zapisie; `[sweep] <glob> — <reguła>; check: <wzorzec>` w `## Changes` (wzorzec uruchamia `review-input`); uwaga wykonawcy bez znacznika trafia do promptu wykonawcy późniejszego zadania, replan wyzwala `[plan]`; `expectedRed` (plan zadania) i `unrelatedRed` (wynik) zamykają naprawę bez agenta; wykonawca z jawną listą narzędzi; `launch.lean` (bez innych wtyczek i MCP); sesja następczyni zatrzymuje sesje wcześniejszych zadań (`claude stop`).
- **Replan (v2.8)** dostaje nowe przyczyny wszystkich zadań od k do końca („for T-j: …”) i zapisuje je jako obsłużone; drobny szczegół widoczny architekt może rozstrzygnąć sam jako `D-n [visible]` (trafia na listę UAT do potwierdzenia). Prompty agentów podają ścieżki względem katalogu głównego repo (`Repo root:` raz).
- **Nowa sesja po zadaniu:** po commicie zadania k < N ta sesja kończy (`handoff`); bez supervisora orkiestrator uruchamia następczynię w tle (`dwmt launch`) i podaje `claude attach <id>`. Awaryjnie: `/clear` i `/dwmt:execute <run>`.
- **Limit abonamentu:** agent trafiony limitem zwraca tekst limitu; `state` rozpoznaje to w transkrypcie (`limit` z czasem odnowienia) i zostawia krok do powtórzenia.
- **Pokrycie AC:** status kryterium sprintu to najgorszy status z zadań; kryterium bez dowodu to luka i `ACCEPTED`.
- **UAT:** `final-report.md` ma listę UAT (start aplikacji z `uat.start`/`uat.notes`, scenariusz architekta, luki kontroli celu, uwagi weryfikatora UI odłożone przez recenzję, kroki 🧑, jak podać wynik). `/dwmt:uat` wstrzymuje scalenia do gałęzi docelowej (bilet z `uat.holdMaxMin`), zapisuje wynik do `uat.md` i podaje polecenie sprintu poprawek (`/dwmt:run "<uat.md>"`). `dwmt uat-summary` liczy przepuszczone defekty według wagi i klasy oraz koszt łączny (sprint, poprawki, sesje UAT).

## Dziennik zdarzeń i alarm przestoju (v2.10)

- **`~/.dwmt/events.jsonl`:** jedna linia JSON na zdarzenie (`ts`, `type`, `project` {name, root}, `run`, `session`, `task`, `verdict`, `costM`, `detail`): `task-start`, `task-end`, `question-waiting`, `command-red`, `stall`, `sprint-end` (z kosztem), `uat-waiting`, `merge-wait`, `uat-recorded`; od sterownika `drive-start` (`pid`) i `drive-stop` (`status`, `reason`, `cause`, `child`, `resetsAt`, `costUsdTotal`: suma przebiegu ze wszystkich startów sterownika). Piszą skrypty (0 tokenów); rotacja powyżej 5 MB do `events.jsonl.1`; wyłączenie: `"events": false` w `~/.dwmt/machine.json`. Błąd zapisu nie przerywa komendy.
- **`dwmt watch`:** `verify` i `finish` zapisują PID w `.dwmt/runs/<run>/active.json` (odświeżany po każdej komendzie, `end` na końcu). Orkiestrator uruchamia `watch` obok nich w tle (`run_in_background`, bez limitu czasu: jedno powiadomienie przy końcu); martwy PID bez `end` (np. zabicie przy braku pamięci) daje od razu jedną linię i zdarzenie `stall`; żywy proces bez przyrostu przez `watch.hangMin` daje „podejrzenie zawieszenia”. Czekanie na Ciebie nie jest przestojem.
- **Sterownik (`drive.enabled: true`, N-2):** `node scripts/drive.mjs <run> [--detach]` prowadzi pętlę `execute` skryptem; agenci jako `claude -p --agent`. Blokada `drive.lock` (pid, start procesu), stan `drive.json` (sesje agentów, PID-y dzieci w `children`, koszt, `startedAt`, `stopped`), postęp `drive.log`. Agent albo komenda bez wyniku (śmierć procesu, brak pliku wyjścia, architekt bez postępu), błąd albo limit agenta → `drive-stop` `stopped` z `cause` (`child-dead`, `no-output`, `no-progress`, `agent-error`, `limit`, `timeout`), bez ponawiania. `drive.hold` → `hold` (kod wyjścia 3) przed następnym zadaniem. Sesja `/dwmt:execute` uruchamia `--detach` i czeka `dwmt wait` w tle. Recenzja N-2: blokada wyłączna (`wx`, martwą przejmuje jeden proces), świeży agent z `--session-id` zapisanym w `run.json` przed startem, agenci bez stdin i bez innych wtyczek (`launch.lean`), dzieci poprzedniego sterownika zatrzymane na starcie, `--detach` bez startu → `ok: false` i `stopped` z końcem `drive.out`, wynik `finish` w linii `wait`.
- **Usuwanie plików:** wykonawca nie usuwa plików ani treści skryptem; pliki do usunięcia architekt wpisuje w nagłówek `delete` planu zadania, orkiestrator pyta raz (`ask-delete`), skrypt usuwa je za zgodą. Pomocnicze skrypty wykonawcy idą do `.dwmt/scratch/` (poza commitem, opróżniany przy commicie).

## Bramka ceny w `run` (D4, spec warstwy produktowej §6.4)

- `init` zapisuje `run.priceGate` i `run.estimate` (`--estimate <min,max>` albo `est` pliku sprintu; bez nich sprint jest „freestyle”).
- Architekt wpisuje w nagłówku `plan.md` `files: [min, max]` razem z pytaniami; brak albo zły format to ostrzeżenie bramki (`gate: error`, bez pytania), nie błąd walidacji planu. Przy pierwszej poprawnej walidacji skrypt liczy cenę: pliki × mln na zmieniony plik kodu (mediana przebiegów projektu w tym trybie, potem wszystkich, potem `product.price.defaultMPerFile`, bez warstwy 0,2); `dwmt price --files <min,max> [--mode m]` liczy to samo z ręki.
- Bramka sama nie dokłada tury pytań (ZAŁOŻENIE do przeglądu, spec §6.4). Sprint oszacowany i projekt ≤ 1,5× górnej granicy szacunku: bez pytania. Ponad granicą: pytanie `Q-price`, także jako osobna tura (reguła drogich rozwiązań). Freestyle: `Q-price` tylko w istniejącej turze pytań architekta; bez pytań architekta bez zatrzymania, a cena idzie do zdania kroku (`priceNote` w `state`) i do raportu. `run.priceGate.askAboveM` (domyślnie `null`): projekt ponad tym progiem mln pyta zawsze. Te same reguły bez warstwy produktowej. Pod sterownikiem pytanie zatrzymuje na `ask-plan`. Odpowiedź w `answers.md` (`### Q-price`, pierwsza linia): `continue`, `shrink: <co odpada>` (wraca do architekta) albo `stop` (stan `stopped`, powód `price`, zdarzenie `sprint-end` z `verdict: stopped`). `inline` nigdy nie pyta.
- Raport: `price: {estimate, design, gate: none|asked|over|error}` (`over`: ponad granicą bez pytania; `error`: ceny nie ma), P narzutu tylko z wywołania architekta po „zmniejsz zakres”; szacunek `stale` nie jest granicą, `estOverhead` (szacunki architekta i tura tylko z powodu ceny wobec kosztu sprintu), `warnings`. Błąd liczenia ceny: bez pytania, ostrzeżenie.

## Warstwa produktowa (D4, etap 1)

- **Pliki** (w gicie, po angielsku, dla agentów; pisze je tylko skrypt): `<product.dir>/backlog.jsonl`, `decisions.md` (`PD-n`), `roadmap.md`, `sprints/<id>.md`, `archive/`, `estimates.jsonl`, `vision.md`, `experts/`. Stan roboczy poza gitem: `.dwmt/product/`.
- **Mechanika:** `dwmt product <komenda>` (`init`, `brief`, `item`, `list`, `triage-auto`, `decision`, `roadmap`, `sprint`, `spec`, `ready-check`, `ready`, `start-check`, `estimate-input`/`estimate-record`, `analog`, `expert`, `import`, `commit` i inne; lista: `dwmt product` bez argumentów). Zapytania drukują tekst, zapisy JSON. `roadmap set <id> state ordered` tylko ze stanu `ready`.

| Komenda | Działanie |
|---|---|
| `product view [--open] [--translate] [--lang <kod>] [--out <plik>]` | strona tylko do odczytu dla człowieka (roadmapa jako tablica stanów Draft / Do zrobienia / W toku / Czeka na przegląd, karta sprintu, backlog, decyzje, historia kosztów): jeden plik w miejscu z `product.view.publish` (domyślnie `<product.dir>/roadmap.html`, commitowany z produktem przez `product commit`; `null` = `<główne drzewo>/.dwmt/product/view/index.html`, poza gitem) z CSS, JS i danymi w środku, bez sieci, 0 tokenów; wynik `{ok, file, sprints, items, decisions, untranslated, forYouMissing, warnings}`; `--open` otwiera w przeglądarce, `--translate` najpierw tłumaczy brakujące tytuły i cele tanim modelem (pamięć `.dwmt/product/view/i18n-<język>.json`, tylko nowe i zmienione), `--out` zapisuje gdzie indziej. Odświeżana sama po `product commit`, `sync`, `brief` i `intake` (błąd = `viewWarning`; przy opublikowanej stronie `finish` i `uat record` zapisują ją w commicie produktu każdego intake, pod blokadą scalania, a po zwolnieniu blokady odświeżają ją raz, bez commitu; przy `publish: null` jest tylko to odświeżenie strony w `.dwmt/`), także wołana z worktree sprintu (dane i strona z głównego drzewa); `product commit` przy `language` ≠ `en` i brakach nie czeka na model: uruchamia odłączony proces tłumaczenia w tle (`viewTranslating: {strings, pid}`; jeden naraz, blokada `.dwmt/product/view/translate.lock`), który po skończeniu odświeża stronę |
| `product for-you [--missing] [--draft [--ids a,b] [--lang <kod>] [--force]]` | sprinty widoczne na stronie bez sekcji `## For you`; `--draft`: szkice sekcji tanim modelem (paczki po 8, bez commitu) |
| `product roadmap todo-from-notes [--dry-run]` | jednorazowo: linie `notes` z niepustym `## Acceptance` → `todo` |
- **Import** (`product import run`): w głównym drzewie na gałęzi importu do końca przeglądu, więc odmawia przy przebiegach w toku (`--force` na Twoją zgodę) i bez wyrenderowanego agenta `dwmt-importer` (`/dwmt:setup`); paczki `batch-<skrót kawałków>`, ponowny `run` po nieudanej paczce kondensuje tylko resztę. Scalenie: `git switch <cel>`, potem `git merge` gałęzi importu; `import retire` zachowuje końce linii pliku.
- **Styki z `run`:** plik sprintu jako wejście, `--item`, `--mode intermediate`, linie architekta (wiążące AC i decyzje pliku sprintu, rejestr `PD-n` przed pytaniem biznesowym, `second` z przyczyną `size:`/`decision:`), linia recenzenta (intencja pozycji z backlogu), `intake` przy `finish` i `uat record`. Z warstwą produktową sprint poprawek z UAT tworzą tylko defekty `blocker`/`major` (`minor` dołącza, sam idzie do triażu), a linia `<sprint>-fix` trafia do roadmapy zaraz za sprintem źródłowym.

## Supervisor (S3, spec supervisora v1.0 §4)

Pętla w skrypcie (`scripts/supervise.mjs`, 0 tokenów), tylko na zlecenie: bez `supervise order` nie ma pętli, autostartu ani `.dwmt/supervisor/`. Zlecenie składa PO (`/dwmt:po`); bez warstwy produktowej te same komendy z terminala: `node <dwmt>/scripts/dwmt.mjs supervise …`.

| Komenda | Działanie |
|---|---|
| `supervise order (--spec <plik…> \| --file <plik…> [--after <id…>]) [--presence here\|away] [--budget M] [--uat-gate <id…>]` | lista prac (`--spec`: tylko sprinty `ready`/`ordered`, dane z `product sprint <id> --json`; `--file` bez `--after` zależy od poprzedniej pozycji, samo `--after` = bez zależności; zależność spoza zlecenia musi być `done`, inaczej odmowa; po zleceniu zależności i kolejność startu idą za bieżącą roadmapą, a zmiana kolejności i wycofanie to edycja roadmapy; pozycje `--file` zachowują `--after`), wejścia `input/<id>.md`, preflight (ostrzeżenia), autostart przy logowaniu (`supervisor.autostart: true`), start pętli w tle |
| `supervise status [--json]` | pozycje ze stanem i regułą czekania, sesje do `claude attach`, sterowniki, koszt i budżet, licznik nocy, UAT, pytania `P-n` |
| `supervise set presence here\|away` / `budget <M>\|none` / `gate <id> on\|off` / `night-limit <n>` | zmiana trybu (historia w `order.md`); `away` ostrzega, gdy squash w nocy nie wejdzie |
| `supervise hold <id>\|all` / `resume <id>\|all` | wstrzymanie (`drive.hold`: bieżący agent kończy pracę) i wznowienie; `resume <id>` zatrzymanej pozycji uruchamia jej sterownik raz |
| `supervise answer <P-n> start\|wait\|continue\|stop\|resume` | odpowiedź na pytanie zarządcze (R1/R5 „startuj mimo to”, budżet, ponowny przestój) |
| `supervise report [--json]` | streszczenie `report.md` (≤ 30 linii) |
| `supervise close` | bez nowych pozycji, wyrejestrowanie autostartu (zawsze); pętla kończy się po ostatnim sterowniku i po doręczeniu powiadomień |
| `supervise run [--once] [--interval s]` | sama pętla (jedna na projekt: `loop.lock`); startuje ją `order`, autostart, `uat record` i `product brief` |

- **Start pozycji:** `preflight` + `init --sprint <id> --worktree` (worktree na sprint, główne drzewo bez zmian), potem `drive.mjs <run> --detach` (`drive.enabled: true`, domyślnie od K4; tryb inny niż `inline`; `auto` = `single`) albo sesja `dwmt launch` (`/dwmt:execute <run>`) przy `"drive": {"enabled": false}` w projekcie albo w trybie `inline`. Jednorazowy komunikat `notice` z `init` (sterownik domyślnie włączony) trafia do `log.md`.
- **Reguły (§4.4):** R1 pytanie „może dotyczyć”/„niepewne” wstrzymuje pozycję (przy `here` pytanie `P-n`); R2 drugi sprint tylko przy pierwszym czekającym w planowaniu, start „tylko planowanie” z `drive.hold`, implementacja po rozłącznych obszarach (zwolnienie raz na zawsze; `drive.hold` sprawdza `dwmt state`, więc wstrzymane zadanie nie daje `task-start`); R3 przy `here` następny sprint planuje wieczorem (zależny: gdy poprzedni jest w `finish`, stop `planned`, wznowienie po scaleniu); R4 limit nocy z `task-start` (`drive.hold`) i budżet; R5 bramka UAT, sprint poprawek z `uat-done`.
- **Zatrzymania sterownika:** `waiting-user` → jedna sesja zatrzymania `/dwmt:execute <run>` (pyta, push, uruchamia sterownik ponownie; pętla zamyka ją potem `claude stop`); `stopped` z powodem → pozycja zatrzymana ze zdarzeniem, bez ponawiania; limit z `resetsAt` → wznowienie po odnowieniu (bez `resetsAt`: 60 min, jedna próba); śmierć sterownika bez `drive-stop` → zdarzenie `stall`, jedno wznowienie, potem zatrzymanie (przy `away` push już przy pierwszej śmierci i przy każdej pozycji zatrzymanej z powodem); `merge-wait` → wznowienie po ustąpieniu przyczyny.
- **Tick:** decyzje pod blokadą `state.lock`, efekty (worktree, sterownik, sesje, powiadomienia, push) bez niej; zamiar efektu zapisany w pozycji przed wykonaniem (`act`), więc pętla zabita w środku kończy start tej samej pozycji na tym samym przebiegu. Błąd odczytu: wpis `[error]` w `log.md`, pętla działa dalej (koniec po 10 kolejnych). Dziennik zdarzeń czytany od przesunięcia z tożsamością pliku (rotacja bez utraty zdarzeń).
- **Pliki:** `.dwmt/supervisor/` (`supervisor.json` stan, `work.md`, `order.md`, `log.md` decyzje z regułą, `pending.md`, `report.md`, `input/`, `status/`), rejestr pętli `~/.dwmt/supervisors/` (`maxActiveSprints`). Każda decyzja: zdarzenie `supervisor` w `~/.dwmt/events.jsonl`.
- **Adapter platformy** (`lib/platform.mjs`): powiadomienie (Windows toast, `osascript`, `notify-send`), czuwanie (`SetThreadExecutionState`, `caffeinate`, `systemd-inhibit`) tylko gdy ktoś pracuje albo pozycja czeka na odnowienie limitu, autostart (`Register-ScheduledTask -AtLogOn` z uruchomieniem bez okna przez `wscript.exe`, na baterii, bez limitu czasu; LaunchAgent, `systemctl --user`) tylko przy otwartym zleceniu i `supervisor.autostart: true` (domyślnie wyłączony do S4); zadanie wskazuje stały plik startowy `~/.dwmt/supervisors/<zadanie>.mjs`, który szuka `scripts/supervise.mjs` w katalogu wtyczki z rejestracji, a potem we wpisach `dwmt@…` w `~/.claude/plugins/installed_plugins.json` (aktualizacja wtyczki z marketplace zmienia katalog wersji); macOS i Linux niesprawdzone. Godziny ciszy z `machine.json` (`quietHours`, np. `"22:00-07:00"`) przesuwają powiadomienia.

## Wyłączanie warstw (P-11)

| Warstwa | Wyłączenie | Bez niej |
|---|---|---|
| warstwa produktowa | brak klucza `product` i katalogu `product.dir`, albo `product.enabled: false` (komendy piszące i `intake` nieaktywne) | `run`, `finish`, `uat` jak w v3-driver |
| bramka ceny | `run.priceGate: false` | plan bez `files`, bez `Q-price`, `run.json` i raport bez pól ceny |
| sterownik | `drive.enabled: false` (domyślnie `true` od K4) | pętla `execute` w sesji orkiestratora |
| supervisor | nie zlecasz pracy (`supervise order`), `supervisor.enabled: false` (blokuje `order`), `supervise close` | PO commituje pliki produktu i startuje sprint przez `init --worktree` + `launch` (główne drzewo zostaje na gałęzi docelowej) albo podaje `/dwmt:run` |

## Hooki

- **`guard-destructive`** (PreToolUse, Bash i PowerShell, także u subagentów) blokuje:
  - `git push`, `reset --hard`, `checkout .`/`-- .`, `restore .`, `clean -f`, `stash` (poza `list`/`show`), `branch -D`;
  - `rm -rf`, `Remove-Item -Recurse` (i aliasy), `rd /s`.

  Domyślnie tylko w sesjach przebiegu dwmt: znacznik `DWMT_RUN` w środowisku (agenci sterownika, sesje `launch`) albo numer sesji zapisany w niezakończonym przebiegu repo (`run.json` bez `stopped`, z `finish` innym niż `squashed` i `left`: bez `finish`, w `merge-wait` albo zatrzymany przez finish na konflikcie, czerwieni, środowisku lub odłożonej poważnej uwadze; w dowolnym drzewie roboczym). `guard.scope`: `run` (domyślnie), `repo` (także każda sesja w repo z niezakończonym przebiegiem), `always` (każda sesja). Zmienna `DWMT_GUARD_SCOPE` wygrywa z configiem i działa w repo bez configu dwmt (np. w `env` ustawień Claude Code użytkownika). Poza sesją przebiegu komunikat podaje zakres i jak go zmienić.
- **`session-start`** (po `compact`, `resume` i `clear`) przypomina o aktywnym przebiegu.

## Rozwój

```text
node dwmt/test/run.mjs fast
node dwmt/test/run.mjs slow
claude plugin validate --strict dwmt
```

- Zestaw szybki (~5 min) biegnie przy finish (`verify.full`); zestaw wolny uruchamiasz ręcznie przed tagiem nowej wersji pluginu dla `dwmt-stable` i kiedy chcesz; lista wolnych plików jest w `dwmt/test/sets.mjs`.

- Szew testów (K4): `DWMT_DRIVE_DEFAULT=off` w środowisku przywraca stary domyślny `drive.enabled: false` dla projektu bez własnego `drive.enabled` (ustawienie projektu wygrywa). Ustawia go `dwmt/test/helpers.mjs` przy imporcie (testy ścieżki sesji); `test/k4-drive.test.mjs` go usuwa. Poza testami go nie ustawiaj.
- `test/prompts.test.mjs` pilnuje budżetów Z10.
- Każda nowa linia promptu wymaga wpisu w `docs/prompt-log.md`.
