// dwmt: agenci (`setup`), `preflight`, `init`, `import-plan`.
import { writeFileSync, existsSync, mkdirSync, appendFileSync, rmSync, copyFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { fixSprintPreview, claimFixSprint, sourceUat } from '../uat.mjs';
import { RULES, is27, writeSizes } from '../plan.mjs';
import { ROOT, fwd, read, asList, canonPath } from './util.mjs';
import { splitHeader, parseYaml, validateHeader } from './headers.mjs';
import { gitRaw, git, dirty, worktreeFor, removeWorktree } from './git.mjs';
import { REBASE, loadConfig, stripJsonComments, detectTarget } from './config.mjs';
import { runDir, taskDir, sessionId, loadRun, saveRun, newTask, taskCtx, writeStatus, foreignTree, runHome } from './run.mjs';
import { unblock, computeState } from './state.mjs';
import { taskBriefErrors } from './plan-state.mjs';
import { envProblems, runCommand } from './verify.mjs';
import { productConfig } from './product-config.mjs';
import { productRun } from '../product.mjs';
import { paths as productPaths, findItem } from './product-store.mjs';
import { estimateOf } from './product-ops.mjs';
import { parseRange } from './price.mjs';
import { writeDirectBrief, directSpec, findingSources } from './direct.mjs';
import { findingSection } from '../batch.mjs';
import { startWorkplaceOf, workplaceTree, startBlock } from './workplace.mjs';

export const TEMPLATE_VERSION = 16;

// ---------- agenci (setup, T1/T11) ----------

const AGENT_TEMPLATES = {
  architect: 'dwmt-architect', explorer: 'dwmt-explorer', executor: 'dwmt-executor', reviewer: 'dwmt-reviewer', checker: 'dwmt-checker', 'ui-verifier': 'dwmt-ui-verifier',
};
// Agenci zastąpieni w v2.7: `setup` ich usuwa, `setup --check` i preflight zgłaszają jako przestarzałych.
const OBSOLETE_AGENTS = ['dwmt-planner'];
export const configHash = (cfg) => createHash('sha256').update(JSON.stringify({ model: cfg.model, roles: cfg.roles })).digest('hex').slice(0, 8);

export function renderAgents(cfg) {
  const hash = configHash(cfg);
  // Weryfikator UI (X7) tylko w projektach z kluczem `ui`.
  return Object.entries(cfg.roles).filter(([role, r]) => cfg.ui || (r.from || role) !== 'ui-verifier').map(([role, r]) => {
    const base = r.from ? cfg.roles[r.from] : r;
    const tplName = AGENT_TEMPLATES[r.from || role];
    if (!tplName || (r.from && !base)) throw new Error(`nieznana rola w configu: ${role}`);
    const eff = { ...base, ...r };
    const vars = { name: `dwmt-${role}`, model: eff.model || cfg.model, effort: eff.effort, maxTurns: eff.maxTurns ?? 100, hash, version: TEMPLATE_VERSION };
    const text = read(join(ROOT, 'templates', 'agents', `${tplName}.md`)).replace(/\r\n/g, '\n')
      .replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
    return { name: vars.name, text };
  }).concat(cfg.product ? [importerAgent(cfg, hash)] : []);
}

// D4 (spec warstwy produktowej §3.10): agent importu tylko w projektach z kluczem `product`; model i effort z
// `product.import.agent` (poza `roles`, więc hash configu i agenci projektów bez warstwy produktowej bez zmian).
function importerAgent(cfg, hash) {
  const a = productConfig('.', cfg).import.agent;
  const vars = { name: 'dwmt-importer', model: a.model || cfg.model, effort: a.effort, maxTurns: a.maxTurns ?? 60, hash, version: TEMPLATE_VERSION };
  const text = read(join(ROOT, 'templates', 'agents', 'dwmt-importer.md')).replace(/\r\n/g, '\n').replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  return { name: vars.name, text };
}

const agentsDir = (top, cfg) => (cfg.agentsScope === 'user' ? join(homedir(), '.claude', 'agents') : join(top, '.claude', 'agents'));
const norm = (s) => s.replace(/\r\n/g, '\n');

export function checkAgents(top, cfg) {
  const dir = agentsDir(top, cfg);
  const missing = [];
  const stale = [];
  for (const a of renderAgents(cfg)) {
    const f = join(dir, `${a.name}.md`);
    if (!existsSync(f)) missing.push(a.name);
    else if (norm(read(f)) !== a.text) stale.push(a.name);
  }
  const obsolete = OBSOLETE_AGENTS.filter((n) => existsSync(join(dir, `${n}.md`)));
  return { ok: !missing.length && !stale.length && !obsolete.length, missing, stale, ...(obsolete.length ? { obsolete } : {}) };
}

// Node: dwmt to skrypty Node, a Claude Code instaluje się bez Node (plik wykonywalny), więc `setup` sprawdza wersję. Brak
// `node` w ogóle łapie skill (polecenie się nie uruchomi). Minimum jak w README; testowane na Node 24.
export const MIN_NODE = 22;
export function nodeProblem(version = process.versions.node) {
  const major = Number(String(version).split('.')[0]);
  return major >= MIN_NODE ? null : `Node ${version}: dwmt wymaga Node >= ${MIN_NODE} (LTS)`;
}

// Przegląd 2026-10-09 (W-7): `wait` w tle sesji PO ginęło przy braku pamięci 8+7+5+3 razy (≈20 „czekaj dalej”), bo
// wyłącznik T-OOM1 (capabilities.md) ma tylko `launch` (LAUNCH_ENV). `setup` dopisuje go do `env` w `.claude/settings.json`
// projektu (scalenie, reszta pliku bez zmian); działa od następnego startu sesji (`product brief` mówi o restarcie).
export const SESSION_ENV = { CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP: '1' };
export function ensureSessionEnv(top, { check = false } = {}) {
  const file = join(top, '.claude', 'settings.json');
  let cur = {};
  // Recenzja poprawek: plik, który nie jest czystym JSON (komentarze, błąd), nie jest przepisywany: linia do dopisania.
  let plain = true;
  if (existsSync(file)) {
    const text = read(file);
    try { cur = JSON.parse(text); } catch {
      plain = false;
      try { cur = JSON.parse(stripJsonComments(text)); } catch { cur = null; }
    }
  }
  const missing = Object.entries(SESSION_ENV).filter(([k, v]) => cur?.env?.[k] !== v).map(([k]) => k);
  if (!missing.length || check) return { file: fwd(file), ok: !missing.length, ...(missing.length ? { missing } : {}) };
  if (!plain) return { file: fwd(file), ok: false, missing, error: `${fwd(file)} nie jest czystym JSON (komentarze albo błąd): nie przepisuję go; dopisz ręcznie w obiekcie "env": ${Object.entries(SESSION_ENV).map(([k, v]) => `"${k}": "${v}"`).join(', ')}` };
  const next = { ...cur, env: { ...(cur.env ?? {}), ...SESSION_ENV } };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
  return { file: fwd(file), ok: true, wrote: missing };
}

// Recenzja poprawek (W-5): bez `verify.unit` reguła testów jednostkowych w zadaniu jest tylko linią promptu architekta;
// pełna suita z runnerem testów frontendu podpowiada wpis.
const FRONT_RUNNER = /\b(vitest|jest|karma|ng test)\b|npm (?:--prefix \S+ )?(?:run )?test\b/;
export function unitWarnings(cfg) {
  if (asList(cfg.verify?.unit).length) return [];
  const hit = asList(cfg.verify?.full).find((c) => FRONT_RUNNER.test(String(c)));
  return hit ? [`verify.unit pusty, a verify.full uruchamia testy jednostkowe (${hit}): dodaj verify.unit [{"glob": "<katalog źródeł>/**", "cmd": "<ta komenda bez opcji> --"}], żeby zadanie zmieniające te pliki uruchamiało je w rundzie (inaczej czerwień wychodzi dopiero przy finish)`] : [];
}

// Writes `git.target` into the config text and keeps comments and layout (a JSON rewrite would lose both). Refuses when
// the edited text would not read back with that target, e.g. a `}` inside a comment of the `git` object.
export function writeTarget(file, target) {
  const text = read(file);
  const value = `"target": ${JSON.stringify(target)}`;
  const g = /"git"\s*:\s*\{/.exec(text);
  let next;
  if (g) {
    const start = g.index + g[0].length;
    const end = text.indexOf('}', start);
    const body = end < 0 ? '' : text.slice(start, end);
    const t = /"target"\s*:\s*(null|"[^"]*")/.exec(body);
    if (t) next = text.slice(0, start + t.index) + value + text.slice(start + t.index + t[0].length);
    else next = text.slice(0, start) + (body.trim() ? ` ${value},` : ` ${value} `) + text.slice(start);
  } else {
    const start = text.indexOf('{') + 1;
    const empty = !text.slice(start).replace(/\}\s*$/, '').trim();
    next = text.slice(0, start) + `\n  "git": { ${value} }${empty ? '\n' : ','}` + text.slice(start);
  }
  let back = null;
  try { back = JSON.parse(stripJsonComments(next)).git?.target; } catch { /* checked below */ }
  if (back !== target) return { ok: false, error: `${fwd(file)}: could not set git.target automatically; set "git": { "target": "${target}" } by hand` };
  writeFileSync(file, next);
  return { ok: true };
}

// Target branch for setup: the config's own value, `--target`, or detection; `targetQuestion` when the user must choose
// (detection not certain, or the configured branch does not exist).
function resolveTarget(top, opts) {
  const has = (b) => gitRaw(['rev-parse', '--verify', '--quiet', `refs/heads/${b}`], { cwd: top }).status === 0;
  const cfg = loadConfig(top);
  const prefix = cfg.git.branchPrefix;
  if (opts.target !== undefined) {
    if (typeof opts.target !== 'string' || !has(opts.target) || opts.target.startsWith(prefix)) return { error: `--target ${opts.target === true ? '' : opts.target}: give an existing local branch that is not a dwmt work branch` };
    return { target: opts.target, source: 'option' };
  }
  const own = cfg.targetDefault ? null : cfg.git.target;
  if (own && has(own)) return { target: own, source: 'config' };
  const det = detectTarget(top, prefix);
  const question = (reason) => ({ reason, candidates: det.candidates.filter((b) => b !== own), recommended: det.recommended ?? (det.certain ? det.target : null) });
  if (own) return { target: own, source: 'config', question: question('missing') };
  const target = det.certain ? det.target : det.recommended ?? det.target;
  return { target, source: det.source, ...(det.certain ? {} : { question: question('uncertain') }) };
}

export function cmdSetup(top, opts) {
  const old = nodeProblem();
  if (old) return { ok: false, error: old, node: process.versions.node, hint: 'zainstaluj Node LTS (Windows: winget install OpenJS.NodeJS.LTS; macOS: brew install node; Linux/WSL: nvm albo pakiet dystrybucji), nowy terminal, potem setup ponownie' };
  const cfgFile = join(top, '.claude', 'dwmt.json');
  const tgt = resolveTarget(top, opts);
  if (tgt.error) return { ok: false, error: tgt.error, hint: 'git branch --list shows the local branches' };
  let wroteConfig = false;
  let wroteTarget = false;
  if (!existsSync(cfgFile) && !opts.check) {
    const pkg = join(top, 'package.json');
    const hasTest = existsSync(pkg) && !!JSON.parse(read(pkg)).scripts?.test;
    mkdirSync(dirname(cfgFile), { recursive: true });
    writeFileSync(cfgFile, `${JSON.stringify({ model: 'opus', verify: { full: hasTest ? ['npm test'] : [] }, git: { target: tgt.target } }, null, 2)}\n`);
    wroteConfig = true;
  } else if (tgt.source === 'option' && !opts.check) {
    const w = writeTarget(cfgFile, tgt.target);
    if (!w.ok) return { ok: false, error: w.error };
    wroteTarget = true;
  }
  const target = { target: tgt.target, targetSource: tgt.source, ...(tgt.question ? { targetQuestion: tgt.question } : {}) };
  const cfg = loadConfig(top);
  const dir = agentsDir(top, cfg);
  const before = checkAgents(top, cfg);
  const warn = [...cfg.warnings, ...unitWarnings(cfg)];
  if (opts.check) return { ok: before.ok, ...before, hash: configHash(cfg), ...target, sessionEnv: ensureSessionEnv(top, { check: true }), ...(warn.length ? { warnings: warn } : {}) };
  mkdirSync(dir, { recursive: true });
  const written = [];
  for (const a of renderAgents(cfg)) {
    const f = join(dir, `${a.name}.md`);
    const eol = existsSync(f) && read(f).includes('\r\n') ? '\r\n' : '\n';
    const text = a.text.replace(/\n/g, eol);
    if (!existsSync(f) || read(f) !== text) { writeFileSync(f, text); written.push(a.name); }
  }
  // v2.7: planista zastąpiony przez architekta; stary plik agenta zostałby w sesji jako martwa rola.
  const removed = OBSOLETE_AGENTS.filter((n) => existsSync(join(dir, `${n}.md`)));
  for (const n of removed) rmSync(join(dir, `${n}.md`), { force: true });
  const sessionEnv = ensureSessionEnv(top);
  const restart = written.length || removed.length || sessionEnv.wrote;
  return {
    ok: true, config: fwd(cfgFile), wroteConfig, wroteTarget, ...target, agentsDir: fwd(dir), written, removed, hash: configHash(cfg), sessionEnv, warnings: [...warn, ...(sessionEnv.error ? [sessionEnv.error] : [])],
    hint: restart ? 'Zacommituj agentów i .claude/settings.json, zrestartuj sesję: nowi agenci i env sesji działają dopiero w nowej sesji (T11, T-OOM1).' : 'Agenci aktualni.',
  };
}

// ---------- preflight, init, import-plan ----------

function settingsBaseRef(top) {
  for (const f of [join(top, '.claude', 'settings.local.json'), join(top, '.claude', 'settings.json'), join(homedir(), '.claude', 'settings.json')]) {
    try { const v = JSON.parse(read(f)).worktree?.baseRef; if (v) return v; } catch { /* brak pliku */ }
  }
  return null;
}

export function slugify(s) {
  return String(s).toLowerCase().replace(/ł/g, 'l').normalize('NFD').replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'run';
}
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

export function cmdPreflight(top, opts) {
  const cfg = loadConfig(top);
  const branch = git(['branch', '--show-current'], { cwd: top });
  const target = cfg.git.target;
  const changes = dirty(top);
  const agents = checkAgents(top, cfg);
  const warnings = [];
  if (!cfg.exists) warnings.push('brak .claude/dwmt.json: uruchom /dwmt:setup');
  warnings.push(...cfg.warnings);
  for (const e of envProblems(top, cfg)) warnings.push(`środowisko: ${e}`);
  const targetExists = gitRaw(['rev-parse', '--verify', '--quiet', `refs/heads/${target}`], { cwd: top }).status === 0;
  const ahead = gitRaw(['rev-list', '--count', `origin/${target}..${target}`], { cwd: top });
  // `--worktree`: przebieg dostanie worktree dwmt (`init --worktree`, od HEAD), więc baza worktree Claude Code nie gra roli.
  if (!opts.worktree && ahead.status === 0 && Number(ahead.stdout.trim()) > 0 && settingsBaseRef(top) !== 'head') {
    warnings.push(`${target} wyprzedza origin/${target} o ${ahead.stdout.trim()} commitów, a worktree.baseRef ≠ head: worktree z Claude Code startuje od origin`);
  }
  const base = `${today()}-${slugify(opts.slug || 'run')}`;
  let run = base;
  // Przebieg w worktree (`init --worktree`) ma katalog tylko tam, ale jego gałąź widać w całym repo.
  const taken = (r) => existsSync(runDir(top, r)) || gitRaw(['rev-parse', '--verify', '--quiet', `refs/heads/${cfg.git.branchPrefix}${r}`], { cwd: top }).status === 0;
  for (let n = 2; taken(run); n++) run = `${base}-${n}`;
  const blockers = [];
  if (!branch) blockers.push('detached HEAD: przełącz się na gałąź');
  if (!targetExists) blockers.push(`gałąź docelowa ${target} nie istnieje: /dwmt:setup (zapyta o gałąź) albo git.target w .claude/dwmt.json`);
  if (!agents.ok) blockers.push('agenci dwmt brakujący lub nieaktualni: uruchom /dwmt:setup i zrestartuj sesję (T11)');
  if (!REBASE.includes(cfg.git.rebase)) blockers.push(`git.rebase = ${cfg.git.rebase}, dozwolone: ${REBASE.join('|')}`);
  return {
    ok: !blockers.length, run, language: cfg.language, branch, target, workBranch: branch === target ? `${cfg.git.branchPrefix}${run}` : branch,
    clean: !changes.length, dirty: changes.slice(0, 5), agents, blockers, warnings,
  };
}

// Wejście od supervisora (§5.1): `<główne drzewo>/.dwmt/supervisor/input/<id>.md`, nagłówek dwmt/sprint-input@1.
function sprintInput(mainTree, id) {
  if (!/^[\w.-]+$/.test(id)) throw new Error(`zły identyfikator sprintu: ${id}`);
  const f = join(mainTree, '.dwmt', 'supervisor', 'input', `${id}.md`);
  if (!existsSync(f)) throw new Error(`brak wejścia sprintu ${fwd(f)}`);
  const text = read(f);
  const s = splitHeader(text);
  const h = s ? parseYaml(s.yaml) : {};
  const errors = validateHeader(h);
  if (errors.length) throw new Error(`${fwd(f)}: ${errors.join('; ')}`);
  if (h.sprint !== id) throw new Error(`${fwd(f)}: sprint ${h.sprint} ≠ ${id}`);
  return { h, body: s.body.trim() };
}

// Warstwa produktowa projektu albo null (bez klucza `product` i katalogu).
function productOf(top, cfg) {
  try { const pc = productConfig(top, cfg); return pc.present ? pc : null; } catch { return null; }
}
// Niezacommitowane zmiany w katalogu produktu (śledzone i nowe pliki).
function productDirty(top, pc) {
  if (!pc || !existsSync(pc.abs)) return [];
  const rel = fwd(pc.dir).replace(/^\.\//, '').replace(/\/$/, '');
  return git(['status', '--porcelain', '--', rel, ...(pc.view?.publish ? [`:(exclude)${fwd(pc.view.publish)}`] : [])], { cwd: top }).split(/\r?\n/).filter(Boolean).map((l) => l.slice(3));
}
const schemaOf = (file) => { try { return parseYaml(splitHeader(read(file))?.yaml ?? '').schema ?? null; } catch { return null; } };

// K4 (D-27): jednorazowy komunikat o sterowniku domyślnie włączonym: projekt bez własnego `drive.enabled`, tryb inny niż
// `inline`; znacznik `.dwmt/drive-default-noted.json` w drzewie domowym przebiegu (główne drzewo także przy worktree).
export const DRIVE_NOTICE = 'Sterownik jest teraz domyślnie włączony: sprint prowadzi skrypt, nie sesja modelu. Powrót do sesji: "drive": {"enabled": false} w .claude/dwmt.json.';
function driveNotice(top, run, cfg) {
  if (!cfg.driveDefault || !cfg.drive?.enabled || run.mode === 'inline') return null;
  const dir = join(runHome(run, top), '.dwmt');
  const marker = join(dir, 'drive-default-noted.json');
  if (existsSync(marker)) return null;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(marker, `${JSON.stringify({ at: new Date().toISOString() })}\n`);
  } catch { /* bez znacznika komunikat wróci przy następnym init */ }
  return DRIVE_NOTICE;
}

export function cmdInit(top, opts) {
  const id = opts.run;
  if (!/^[\w.-]+$/.test(id || '')) throw new Error('podaj --run <id> z preflight');
  if (existsSync(join(runDir(top, id), 'run.json'))) {
    const run = loadRun(top, id);
    return { ok: true, existing: true, run: id, branch: run.branch, dir: fwd(runDir(top, id)), brief: fwd(join(taskCtx(runDir(top, id), run).dir, 'brief.md')) };
  }
  // K7 D-16: a sprint assigned to a workplace always runs in its own run worktree, also without --worktree.
  if (opts.worktree || (!opts.target && workplaceFor(top, opts))) return initInWorktree(top, opts);
  const cfg = loadConfig(top);
  // K7 D-2 (C-3): a workplace sprint's target is the workplace branch (initInWorktree passes it), else git.target.
  const target = opts.target ?? cfg.git.target;
  const branch = git(['branch', '--show-current'], { cwd: top });
  if (!branch) throw new Error('detached HEAD');
  // D-2: drzewo domowe przed `switch -c` (drzewo z gałęzią docelową, inaczej wołające; `--worktree` podaje je w `opts.home`).
  const home = canonPath(opts.home ?? worktreeFor(top, target) ?? top);
  // Recenzja N-4: przebieg na miejscu commituje `git add -A`, więc zmiany katalogu produktu (zapisy PO, `intake`) weszłyby
  // do commitów sprintu; na gałęzi importu produktu przebieg dokładałby pracę do importu.
  const pc = productOf(top, cfg);
  if (pc && branch === pc.import.branch) throw new Error(`gałąź ${branch} to gałąź importu produktu: najpierw git switch ${target} (przegląd importu w /dwmt:po)`);
  const pdirty = productDirty(top, pc);
  if (pdirty.length) throw new Error(`katalog produktu ${pc.dir} ma niezacommitowane zmiany (${pdirty.slice(0, 3).join(', ')}): najpierw dwmt product commit, inaczej wejdą do commitów sprintu`);
  // K7 F-2: a workplace run reads the product (spec text, state, estimate, items) from the home tree: the workplace
  // branch's docs/product may be older than the main tree's or miss the sprint (a user's branch cut before it existed).
  const prod = opts.workplace ? home : top;
  const prodCfg = opts.workplace ? loadConfig(home) : cfg;
  // Wejście czytamy przed założeniem gałęzi: błąd wejścia nie zostawia śladów.
  let kind = 'text';
  let input = null;
  const warnings = [];
  if (opts.sprint) {
    input = sprintInput(home, opts.sprint);
    kind = 'sprint';
    // Sprint poprawek od supervisora (`source`): defekty z uat.md sprintu źródłowego w kopii przebiegu.
    if (input.h.source) { input.fix = sourceUat(home, input.h.source, input.h.sourceRun ?? null); fixSprintPreview(input.fix); }
  }
  else if (opts.input) {
    if (!existsSync(opts.input)) throw new Error(`brak pliku wejścia: ${opts.input}`);
    const text = read(opts.input);
    const schema = (() => { try { return parseYaml(splitHeader(text)?.yaml ?? '').schema; } catch { return null; } })();
    kind = schema === 'dwmt/brief@1' ? 'brief' : schema === 'dwmt/uat@1' ? 'uat' : schema === 'dwmt/sprint-spec@1' ? 'spec' : 'task';
    input = { text, file: fwd(resolve(opts.input)) };
    if (kind === 'uat') input.fix = fixSprintPreview(input.file);
    if (kind === 'spec') {
      // D4 (spec warstwy produktowej §6.1): plik sprintu → `task.md` z `product sprint <id>` (linia roadmapy, plik,
      // rozwinięte pozycje i PD-n); sprint poza `ready`/`ordered` tylko po zgodzie użytkownika (`--force`).
      input.spec = specInput(prod, input.text);
      if (!['ready', 'ordered'].includes(input.spec.state) && !opts.force) {
        return { ok: false, notReady: true, spec: input.spec.id, state: input.spec.state, error: `sprint ${input.spec.id} is ${input.spec.state}, not ready`, hint: 'zapytaj użytkownika, czy uruchomić mimo to; tak → to samo init z --force' };
      }
    }
  } else if (opts.item && opts.item !== true) {
    // D4 (§4.12 pkt 2): bardzo małe zadanie z pozycji backlogu, bez pliku sprintu i linii roadmapy.
    kind = 'items';
    input = itemsInput(prod, String(opts.item));
  }
  // D4 (§4.12 pkt 4): `intermediate` to etykieta ceny i statystyki na trybie `single` (v2.10 zna auto|inline|single).
  let mode = opts.mode || 'auto';
  if (kind === 'spec' && mode === 'auto' && ['inline', 'intermediate', 'single', 'direct'].includes(input.spec.header?.mode)) mode = input.spec.header.mode;
  const modeLabel = mode === 'intermediate' ? 'intermediate' : null;
  if (modeLabel) mode = 'single';
  // D4 (§6.4 pkt 1): szacunek sprintu dla bramki ceny: `--estimate` (cena przyjęta przy starcie), `est` pliku sprintu, inaczej null.
  const gate = cfg.run?.priceGate !== false;
  let estimate = null;
  if (opts.estimate && opts.estimate !== true) estimate = { tokensM: parseRange(opts.estimate, '--estimate'), src: 'start' };
  else if (kind === 'spec' && input.spec.header?.est) {
    try {
      const e = estimateOf(productPaths(prod, productConfig(prod, prodCfg)), input.spec.header.est);
      // Szacunek `stale` (zakres zmienił się po szacunku, §3.6) nie jest granicą bramki: sprint idzie jak freestyle.
      if (e?.stale) warnings.push(`est ${input.spec.header.est}: szacunek nieaktualny (stale), bramka ceny bez granicy szacunku`);
      else if (e?.tokensM) estimate = { tokensM: e.tokensM, src: e.src };
      else warnings.push(`est ${input.spec.header.est}: brak szacunku w estimates.jsonl (sprint bez szacunku)`);
    } catch (e) { warnings.push(`est ${input.spec.header.est}: ${e.message}`); }
  }
  let work = branch;
  const baseline = git(['merge-base', target, 'HEAD'], { cwd: top });
  if (branch === target) { work = `${cfg.git.branchPrefix}${id}`; git(['switch', '-c', work], { cwd: top }); }
  const root = runDir(top, id);
  mkdirSync(taskDir(root, 1), { recursive: true });
  const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: top });
  const exclude = join(common, 'info', 'exclude');
  mkdirSync(dirname(exclude), { recursive: true });
  const ex = existsSync(exclude) ? read(exclude) : '';
  if (!/^\/?\.dwmt\/?$/m.test(ex)) appendFileSync(exclude, `${ex && !ex.endsWith('\n') ? '\n' : ''}.dwmt/\n`);
  // v2.7: `rules` wybiera profil walidacji i stany architekta (przebieg bez pola kończy się regułami v2.6, §5.9);
  // `planBase` to merge-base, na którym architekt planuje (kod, który czyta).
  const run = {
    schema: 'dwmt/run@1', run: id, rules: RULES, mode, phase: 'plan', branch: work, target, homeTree: home, ...(opts.workplace ? { workplace: opts.workplace.name } : {}),
    created: new Date().toISOString(), configHash: configHash(cfg), planBase: baseline,
    task: 1, count: null, tasks: [newTask(1, baseline, cfg)], handoff: null, fullVerify: null, finish: null, session_ids: sessionId() && !foreignTree(top) ? [sessionId()] : [],
  };
  // Tryb A (recenzja): `init --worktree` z sesji PO w głównym drzewie: sesja tylko w oknie `callers` (koszt sprintu bez rozmowy PO).
  if (sessionId() && foreignTree(top)) { const now = run.created; run.callers = [{ id: sessionId(), from: now, to: now }]; }
  // D4: pola tylko wtedy, gdy są (bez warstwy produktowej i z `run.priceGate: false` run.json jak w v3-driver).
  // W-4 (przegląd 2026-10-09): próg plików trybu pośredniego w przebiegu; architekt szacujący więcej dzieli sprint (→ single).
  if (modeLabel) { run.modeLabel = modeLabel; run.intermediateMaxFiles = productConfig(prod, prodCfg).start.intermediateMaxFiles ?? 60; }
  if (kind === 'spec') run.spec = input.spec.id;
  if (kind === 'items') run.items = input.ids;
  // E (noc 2026-10-05): tryb direct zapamiętuje tytuły pozycji (kryteria planu pisanego przez skrypt).
  if (mode === 'direct' && kind === 'items') run.directItems = input.items;
  if (gate) Object.assign(run, { priceGate: true, estimate });
  else if (estimate) run.estimate = estimate;
  if (kind === 'sprint') {
    const h = input.h;
    Object.assign(run, { sprint: h.sprint, order: asList(h.order), after: asList(h.after), first: h.first ?? null, uatGate: !!h.uatGate, ...(h.source ? { source: { sprint: h.source } } : {}) });
    // S3: pozycja zlecenia z pliku sprintu (`supervise order --spec`) niesie id specyfikacji (raport, sync, intake).
    if (h.spec && /^[\w.-]+$/.test(String(h.spec))) run.spec = String(h.spec);
    let body = input.body;
    if (input.fix) {
      const fix = claimFixSprint(input.fix, id);
      run.source = fix.source;
      body = `${body}\n\n${fix.task}`;
    }
    writeFileSync(join(root, 'task.md'), `${body}\n`);
  } else if (kind === 'task') writeFileSync(join(root, 'task.md'), input.text);
  else if (kind === 'spec' || kind === 'items') writeFileSync(join(root, 'task.md'), `${String(kind === 'spec' ? input.spec.task : input.task).trimEnd()}\n`);
  else if (kind === 'uat') {
    const fix = claimFixSprint(input.file, id);
    run.source = fix.source;
    writeFileSync(join(root, 'task.md'), fix.task);
  }
  // D4 (§4.6): sprint poprawek z warstwą produktową ma linię roadmapy `<źródło>-fix` (intake --uat); `sync` zamyka ją po scaleniu.
  if (run.source?.sprint && !run.spec) { const fid = fixSpecOf(prod, run.source.sprint); if (fid) run.spec = fid; }
  saveRun(top, run);
  writeSizes(top, root, cfg);
  // E: plan zadania 1 pisze skrypt (bez architekta); wejście tekstowe dostaje go w `state`, gdy sesja zapisze task.md.
  if (mode === 'direct' && kind !== 'brief' && existsSync(join(root, 'task.md'))) {
    // Treść uwag z recenzji źródłowego przebiegu (pozycje z intake mają w backlogu sam tytuł).
    const sources = kind === 'items' ? findingSources(home, input.items, findingSection) : '';
    if (sources) appendFileSync(join(root, 'task.md'), `\n${sources}\n`);
    writeDirectBrief(root, run, directSpec(read(join(root, 'task.md')), { goal: kind === 'spec' ? input.spec.header?.goal ?? null : null, items: asList(run.directItems) }));
  }
  let imported = null;
  if (kind === 'brief') imported = importBrief(top, run, input.text, input.file);
  if (run.sprint) writeStatus(top, run, 'planning', { stage: 'sprint' });
  const notice = driveNotice(top, run, cfg);
  return {
    ...(notice ? { notice } : {}),
    ok: !imported || imported.ok, run: id, kind, branch: work, created: work !== branch, baseline: baseline.slice(0, 10), dir: fwd(root), ...(opts.workplace ? { workplace: opts.workplace } : {}),
    brief: fwd(join(taskDir(root, 1), 'brief.md')), ...(run.sprint ? { sprint: run.sprint } : {}), ...(run.source ? { source: run.source.sprint, defects: run.source.defects } : {}),
    ...(run.spec ? { spec: run.spec } : {}), ...(run.items ? { items: run.items } : {}), ...(modeLabel ? { mode: run.mode, modeLabel } : {}), ...(run.estimate ? { estimate: run.estimate } : {}),
    ...(imported ? { errors: imported.errors, warnings: [...imported.warnings, ...warnings] } : warnings.length ? { warnings } : {}),
    hint: kind === 'text' ? 'zapisz tekst zadania do task.md w katalogu przebiegu' : imported && !imported.ok ? 'brief niepoprawny: popraw go i import-plan' : 'uruchom execute',
  };
}

// Recenzja N-4 (PO startuje sprint w tle): przebieg we własnym worktree (`supervisor.worktreeDir`, domyślnie
// `.claude/worktrees/<run>`, jak spec supervisora §4.1), więc główne drzewo zostaje na gałęzi docelowej: zapisy PO nie
// wchodzą do commitów sprintu, a `finish` innych przebiegów nie czeka (`merge-wait`) na inną gałąź. Worktree powstaje
// z HEAD, więc pliki produktu czytane przez `init` (plik sprintu, `--item`) muszą być zacommitowane.
function initInWorktree(top, opts) {
  const cfg = loadConfig(top);
  const id = opts.run;
  // D-5: worktree przebiegu pod drzewem domowym (z gałęzią docelową, inaczej wołającym), nie pod pierwszym z listy.
  const home = canonPath(worktreeFor(top, cfg.git.target) ?? top);
  const branch = `${cfg.git.branchPrefix}${id}`;
  const held = worktreeFor(top, branch);
  if (held && existsSync(join(runDir(held, id), 'run.json'))) return { ...cmdInit(held, { ...opts, worktree: false }), worktree: held };
  if (gitRaw(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: top }).status === 0) throw new Error(`gałąź ${branch} już istnieje: nowy --run z preflight`);
  // K7 (D-1, D-7, C-3): a workplace sprint refuses on its start block before anything is created; its run worktree
  // starts at the workplace branch tip and its target is that branch.
  const wp = workplaceFor(top, opts);
  let from = 'HEAD';
  let wpOut = null;
  if (wp) {
    const block = startBlock(home, wp);
    if (block) {
      const own = `workplace ${wp.name}`;
      const rest = block.text.startsWith(own) ? block.text.slice(own.length).replace(/^:?\s*/, '') : block.text;
      throw new Error(`${own}: ${rest}`);
    }
    const tree = canonPath(workplaceTree(home, wp));
    from = `refs/heads/${wp.branch}`;
    wpOut = { name: wp.name, branch: wp.branch, tree: fwd(tree) };
  }
  const pc = productOf(top, cfg);
  const kind = opts.item && opts.item !== true ? 'items' : opts.input && opts.input !== true && existsSync(opts.input) && schemaOf(opts.input) === 'dwmt/sprint-spec@1' ? 'spec' : null;
  if (kind) {
    const pdirty = productDirty(top, pc);
    if (pdirty.length) throw new Error(`katalog produktu ${pc.dir} ma niezacommitowane zmiany (${pdirty.slice(0, 3).join(', ')}): najpierw dwmt product commit (worktree powstaje z ostatniego commitu)`);
  }
  if (kind === 'spec' && !opts.force) {
    const s = specInput(wp ? home : top, read(opts.input));
    if (!['ready', 'ordered'].includes(s.state)) return { ok: false, notReady: true, spec: s.id, state: s.state, error: `sprint ${s.id} is ${s.state}, not ready`, hint: 'zapytaj użytkownika, czy uruchomić mimo to; tak → to samo init z --force' };
  }
  const dirRel = String(cfg.supervisor?.worktreeDir || '.claude/worktrees').replace(/\\/g, '/').replace(/\/+$/, '');
  const wt = fwd(resolve(home, dirRel, id));
  if (existsSync(wt)) throw new Error(`katalog worktree ${wt} już istnieje`);
  // Katalog worktree poza gitem głównego drzewa (inaczej główne drzewo byłoby zawsze brudne).
  if (gitRaw(['check-ignore', '-q', `${dirRel}/${id}`], { cwd: home }).status !== 0) {
    const exclude = join(git(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: top }), 'info', 'exclude');
    mkdirSync(dirname(exclude), { recursive: true });
    const ex = existsSync(exclude) ? read(exclude) : '';
    appendFileSync(exclude, `${ex && !ex.endsWith('\n') ? '\n' : ''}/${dirRel}/\n`);
  }
  mkdirSync(dirname(wt), { recursive: true });
  if (wp) catchUpWorkplace(wpOut.tree, wp);
  git(['worktree', 'add', '-q', '-b', branch, wt, from], { cwd: top });
  const drop = () => { removeWorktree(home, wt, { force: true }); gitRaw(['branch', '-D', branch], { cwd: home }); };
  const warnings = [];
  try {
    // Pliki lokalne, których worktree z gita nie dostaje: config dwmt, uprawnienia sesji, agenci (gdy niezacommitowani).
    // Najpierw z drzewa wołającego (jego config ma `product.dir` i `git.target` tego sprintu), potem z domowego (bugs.txt pkt 14, D-5).
    const from = (rel) => [join(top, rel), join(home, rel)].find((p) => existsSync(p)) ?? null;
    const agents = from(join('.claude', 'agents'));
    const local = ['.claude/dwmt.json', '.claude/settings.local.json', ...(agents ? readdirSync(agents).filter((f) => f.endsWith('.md')).map((f) => `.claude/agents/${f}`) : [])];
    for (const rel of local) {
      const src = from(rel);
      const dst = join(wt, rel);
      if (src && !existsSync(dst)) { mkdirSync(dirname(dst), { recursive: true }); copyFileSync(src, dst); }
    }
    const wcfg = loadConfig(wt);
    for (const c of asList(wcfg.supervisor?.worktreeSetup)) {
      const r = runCommand(String(c), wt, wcfg.verify?.shell || null);
      if (r.exit !== 0) warnings.push(`worktreeSetup: ${c} (exit ${r.exit})`);
    }
    const r = cmdInit(wt, { ...opts, worktree: false, home, ...(wpOut ? { target: wpOut.branch, workplace: wpOut } : {}), ...(opts.input && opts.input !== true ? { input: resolve(opts.input) } : {}) });
    if (r.notReady) { drop(); return r; }
    return { ...r, worktree: wt, created: true, ...(warnings.length ? { warnings: [...asList(r.warnings), ...warnings] } : {}), hint: `przebieg w worktree ${wt}${wpOut ? ` (gałąź ${wpOut.branch} miejsca pracy ${wpOut.name})` : ''}; główne drzewo bez zmian: dwmt launch ${id}` };
  } catch (e) { drop(); throw e; }
}

// K7: the spec id of the init input (the `--input` sprint-spec header `id`; for `--sprint` its input field `spec`, else the
// sprint id) and its workplace in the home tree (active, or removed while it still holds the sprint: batch T-2/F-3, D-7
// refuses the start), or null (no input of these kinds, no workplace, no product layer).
function workplaceFor(top, opts) {
  let cfg;
  try { cfg = loadConfig(top); } catch { return null; }
  const home = canonPath(opts.home ?? worktreeFor(top, cfg.git.target) ?? top);
  let id = null;
  if (opts.sprint && opts.sprint !== true) {
    let h = {};
    try { h = parseYaml(splitHeader(read(join(home, '.dwmt', 'supervisor', 'input', `${opts.sprint}.md`)))?.yaml ?? '') ?? {}; } catch { /* sprintInput reports it */ }
    id = h.spec && /^[\w.-]+$/.test(String(h.spec)) ? String(h.spec) : String(opts.sprint);
  } else if (opts.input && opts.input !== true && existsSync(opts.input)) {
    try { const h = parseYaml(splitHeader(read(opts.input))?.yaml ?? ''); if (h?.schema === 'dwmt/sprint-spec@1' && h.id) id = String(h.id); } catch { /* not a sprint file */ }
  }
  return id ? startWorkplaceOf(home, id) : null;
}

// K7 D-14: a branch dwmt created that has no commits of its own (an ancestor of its base) moves forward to the base tip,
// in the workplace tree (clean: startBlock checked it); a user's branch, a branch with own commits or a missing base stays.
function catchUpWorkplace(tree, wp) {
  const base = wp.base?.ref;
  if (!wp.created || !base || !tree) return;
  if (gitRaw(['rev-parse', '--verify', '--quiet', `${base}^{commit}`], { cwd: tree }).status !== 0) return;
  if (gitRaw(['merge-base', '--is-ancestor', `refs/heads/${wp.branch}`, base], { cwd: tree }).status !== 0) return;
  git(['merge', '--ff-only', '-q', base], { cwd: tree });
}

// Linia roadmapy sprintu poprawek (`<źródło>-fix`) albo null (bez warstwy produktowej, bez linii, sprint zamknięty).
function fixSpecOf(top, source) {
  try { const j = productRun(top, ['sprint', `${source}-fix`, '--json']); return ['closed', 'dropped'].includes(j.state) ? null : j.id; } catch { return null; }
}

// D4: plik sprintu (`dwmt/sprint-spec@1`) przez zapytanie produktu: tekst do `task.md`, stan i nagłówek z `--json`.
function specInput(top, text) {
  let id = null;
  try { id = parseYaml(splitHeader(text).yaml).id; } catch { /* niżej */ }
  if (!/^[\w.-]+$/.test(String(id ?? ''))) throw new Error('plik sprintu bez poprawnego id w nagłówku');
  const j = productRun(top, ['sprint', String(id), '--json']);
  return { id: String(id), state: j.state, header: j.header ?? {}, task: productRun(top, ['sprint', String(id)]) };
}

// D4 (§4.12 pkt 2): `--item B-1,B-2` → `task.md` z `product item <id> --detail` każdej pozycji.
function itemsInput(top, raw) {
  const refs = raw.split(',').map((x) => x.trim()).filter(Boolean);
  if (!refs.length) throw new Error('--item: podaj identyfikatory pozycji (B-1,B-2)');
  // Alias → B-n (recenzja N-4): `sync` zamyka pozycje przebiegu `--item` po identyfikatorze B-n z `run.items`.
  const P = productPaths(top, productConfig(top, loadConfig(top)));
  const ids = [...new Set(refs.map((x) => { const hit = findItem(P, x); if (!hit) throw new Error(`--item ${x}: brak pozycji (B-n albo alias)`); return hit.item.id; }))];
  const texts = ids.map((x) => productRun(top, ['item', x, '--detail']));
  const items = ids.map((x) => { const it = findItem(P, x)?.item; return { id: x, title: String(it?.title ?? x), src: it?.src ?? null }; });
  return { ids, items, task: ['# Task: backlog items', '', ...texts.flatMap((t) => [String(t).trimEnd(), ''])].join('\n') };
}

// Gotowy brief do katalogu bieżącego zadania (nowy układ: tasks/<k>/brief.md) z walidacją jak w `state`.
function importBrief(top, run, text, file) {
  const root = runDir(top, run.run);
  const cfg = loadConfig(top);
  const ctx = taskCtx(root, run);
  mkdirSync(ctx.dir, { recursive: true });
  writeFileSync(join(ctx.dir, 'brief.md'), text);
  // Nowy plan zadania to nowe planowanie: pełna walidacja, dopóki `state` znowu nie wyjdzie z planowania.
  if (is27(run) && !existsSync(join(root, 'plan.md'))) delete run.plansReady;
  const errors = [];
  const h = splitHeader(text);
  let hdr = {};
  if (!h) errors.push('plan musi zaczynać się nagłówkiem YAML (---)');
  else {
    try { hdr = parseYaml(h.yaml); errors.push(...validateHeader(hdr)); if (!errors.length) errors.push(...taskBriefErrors(root, run, ctx, text, hdr, cfg)); } catch (e) { errors.push(e.message); }
    if (hdr.run && hdr.run !== run.run) errors.push(`run w nagłówku (${hdr.run}) ≠ ${run.run}`);
  }
  const warnings = run.mode !== 'auto' && hdr.mode && hdr.mode !== run.mode ? [`tryb z argumentu ${run.mode}, w planie ${hdr.mode}`] : [];
  run.plan = fwd(file);
  const unblocked = unblock(ctx.dir, computeState(root, run, cfg).round);
  saveRun(top, run);
  return { ok: !errors.length, brief: fwd(join(ctx.dir, 'brief.md')), mode: hdr.mode ?? null, errors, warnings, unblocked };
}

export function cmdImportPlan(top, file, opts) {
  if (!file || !existsSync(file)) throw new Error(`brak pliku planu: ${file}`);
  const run = loadRun(top, opts.run);
  const r = importBrief(top, run, read(file), file);
  return { ...r, run: run.run, hint: r.errors.length ? `popraw brief i sprawdź: dwmt.mjs header ${r.brief} --check` : 'uruchom execute' };
}
