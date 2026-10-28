// dwmt S3: adapter platformy supervisora (spec supervisora §4.7): jedyny kod zależny od systemu. Powiadomienie na pulpicie,
// czuwanie maszyny, autostart pętli przy logowaniu. Windows sprawdzony w S1 (T-S14); macOS i Linux niesprawdzone (fallback:
// brak narzędzia = ostrzeżenie, noc bez tej funkcji). 0 tokenów.
// Testy: `DWMT_PLATFORM_LOG=<plik>` zapisuje wywołania jako linie JSON zamiast je wykonywać (bez toastów i zadań systemu).
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { canonPath, samePath } from './util.mjs';

const logged = (fn, args) => {
  const f = process.env.DWMT_PLATFORM_LOG;
  if (!f) return false;
  try { appendFileSync(f, `${JSON.stringify({ at: new Date().toISOString(), fn, ...args })}\n`); } catch { /* best effort */ }
  return true;
};
const run = (cmd, args, env = {}) => {
  try { return spawnSync(cmd, args, { encoding: 'utf8', timeout: 30e3, windowsHide: true, env: { ...process.env, ...env } }); } catch (e) { return { status: null, error: e }; }
};
const ps = (script, env = {}) => run('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], env);
const fwdP = (p) => String(p).replace(/\\/g, '/');
// D-15: lower-cased canonical path on every platform (earlier versions hashed the lower-cased git-form path; same names
// for local paths without reparse points; for a subst or mapped drive see legacyTasks).
export const taskName = (root) => `dwmt-supervisor-${createHash('sha256').update(canonPath(root).toLowerCase()).digest('hex').slice(0, 8)}`;

// Powiadomienie na pulpicie (jedna linia). Tekst idzie zmienną środowiska, nie argumentem (bez cytowania zależnego od systemu).
export function notify(text, { title = 'dwmt' } = {}) {
  if (logged('notify', { text })) return true;
  const env = { DWMT_MSG: String(text), DWMT_TITLE: title };
  if (process.platform === 'win32') {
    const r = ps(`[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$x = $t.GetElementsByTagName('text'); $x.Item(0).AppendChild($t.CreateTextNode($env:DWMT_TITLE)) | Out-Null; $x.Item(1).AppendChild($t.CreateTextNode($env:DWMT_MSG)) | Out-Null
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show([Windows.UI.Notifications.ToastNotification]::new($t))`, env);
    return r.status === 0;
  }
  if (process.platform === 'darwin') return run('osascript', ['-e', 'display notification (system attribute "DWMT_MSG") with title (system attribute "DWMT_TITLE")'], env).status === 0;
  return run('notify-send', [title, String(text)]).status === 0;
}

// Opener of a local file in the default program: [command, args]. Windows: the shell's file handler without a command
// interpreter (no parsing of `&`, `^`, `%` or quotes in the path); its exit code means nothing and is ignored.
export function openerOf(file, platform = process.platform) {
  const f = String(file);
  if (platform === 'win32') return ['rundll32.exe', ['url.dll,FileProtocolHandler', f]];
  return platform === 'darwin' ? ['open', [f]] : ['xdg-open', [f]];
}
// Opens a local file in the default program (the product view). Never throws: false when no opener could start.
export function openFile(file) {
  const [cmd, args] = openerOf(file);
  if (logged('open', { file: String(file), cmd, args })) return true;
  try { const p = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }); p.on('error', () => {}); p.unref(); return true; } catch { return false; }
}

// A detached process that outlives this one (no console window, output dropped). → {pid} or null when it could not start.
export function spawnDetached(cmd, args, { cwd = process.cwd(), env = process.env } = {}) {
  if (logged('spawn', { cmd: String(cmd), args: args.map(String), cwd: String(cwd) })) return { pid: null, logged: true };
  try {
    const p = spawn(cmd, args, { cwd, env, detached: true, stdio: 'ignore', windowsHide: true });
    p.on('error', () => {});
    p.unref();
    return { pid: p.pid ?? null };
  } catch { return null; }
}

// Czuwanie: proces potomny trzyma maszynę obudzoną, dopóki żyje proces `pid` (pętla) albo do `stop()`.
// Windows: SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED) i Wait-Process; macOS: caffeinate -i -w;
// Linux: systemd-inhibit z `tail --pid`. Zwraca {stop()} albo null (brak narzędzia).
export function keepAwake(pid = process.pid) {
  if (logged('keepAwake', { on: true, pid })) return { stop: () => logged('keepAwake', { on: false, pid }) };
  let p;
  try {
    if (process.platform === 'win32') {
      p = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', `$k = Add-Type -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);' -Name K -Namespace DwmtAwake -PassThru; $k::SetThreadExecutionState([uint32]2147483649) | Out-Null; Wait-Process -Id ${Number(pid)}`], { stdio: 'ignore', windowsHide: true });
    } else if (process.platform === 'darwin') p = spawn('caffeinate', ['-i', '-w', String(Number(pid))], { stdio: 'ignore' });
    else p = spawn('systemd-inhibit', ['--what=sleep', '--who=dwmt', '--why=dwmt supervisor', 'tail', `--pid=${Number(pid)}`, '-f', '/dev/null'], { stdio: 'ignore' });
  } catch { return null; }
  p.on('error', () => { /* brak narzędzia: noc bez czuwania (preflight ostrzega) */ });
  return { stop: () => { try { p.kill(); } catch { /* już nie żyje */ } } };
}

// Autostart pętli przy logowaniu, tylko dopóki zlecenie jest otwarte (S9). Recenzja S3 (5):
// - stała ścieżka: zadanie systemu wskazuje plik startowy `<dir>/<nazwa>.mjs` (`~/.dwmt/supervisors/`), nie skrypt wtyczki.
//   Plik startowy szuka `scripts/supervise.mjs` w katalogu wtyczki z rejestracji, a gdy go nie ma (aktualizacja wtyczki
//   z marketplace zmienia katalog wersji w cache), we wpisach `dwmt@…` z `~/.claude/plugins/installed_plugins.json`;
//   wtyczka z `--plugin-dir` ma ścieżkę stałą z natury. `supervise order` rejestruje zadanie od nowa (`-Force`).
// - Windows: uruchomienie bez okna konsoli (`wscript.exe` z plikiem `.vbs`, okno 0), także na baterii, bez limitu czasu
//   (`ExecutionTimeLimit` 0), jedna instancja. VBScript jest w Windows 11 funkcją opcjonalną (Microsoft zapowiada jego
//   wycofanie): bez `wscript.exe` preflight ostrzega.
// - wyłączenie usuwa zadanie i pliki startowe; woła je `close` i koniec zakresu zawsze (także po zmianie configu).
const winPath = (p) => String(p).replace(/\//g, '\\');
export function autostartFiles({ root, script, dir }) {
  const name = taskName(root);
  const shim = join(dir, `${name}.mjs`);
  const vbs = join(dir, `${name}.vbs`);
  const shimText = `// dwmt: plik startowy autostartu pętli supervisora (generowany przez \`supervise order\`; usuwa go \`supervise close\`).
// Projekt: ${root}
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
const roots = [${JSON.stringify(dirname(dirname(script)))}];
try {
  const reg = JSON.parse(readFileSync(join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'plugins', 'installed_plugins.json'), 'utf8'));
  for (const [k, v] of Object.entries(reg.plugins ?? {})) if (/^dwmt@/.test(k)) for (const e of [].concat(v)) if (e?.installPath) roots.push(e.installPath);
} catch { /* bez rejestru wtyczek */ }
const root = roots.find((r) => existsSync(join(r, 'scripts', 'supervise.mjs')));
if (!root) { console.error(\`dwmt: scripts/supervise.mjs not found in \${roots.join(', ')}\`); process.exit(1); }
const m = await import(pathToFileURL(join(root, 'scripts', 'supervise.mjs')).href);
const argv = process.argv.slice(2);
const out = await m.superviseMain(process.cwd(), argv.length ? argv : ['run']);
console.log(typeof out === 'string' ? out : JSON.stringify(out));
`;
  const vbsText = `' dwmt: start bez okna konsoli (autostart supervisora ${name})\r\nSet s = CreateObject("WScript.Shell")\r\ns.CurrentDirectory = "${winPath(root)}"\r\ns.Run """${winPath(process.execPath)}"" ""${winPath(shim)}"" run", 0, False\r\n`;
  return { name, shim, vbs, shimText, vbsText };
}

// Tasks of this project under another name (T-1/F-1): earlier versions hashed the git-form path, so on a subst or mapped
// drive (canonPath resolves `Z:/proj` to its target or `//server/share/proj`) or a short 8.3 spelling their task has
// another name. Found through the shims in `dir`: each names its project in the `// Projekt: <root>` line.
export function legacyTasks(root, dir) {
  const name = taskName(root);
  let files = [];
  try { files = readdirSync(dir); } catch { return []; }
  const out = [];
  for (const f of files) {
    const m = /^(dwmt-supervisor-[0-9a-f]{8})\.mjs$/.exec(f);
    if (!m || m[1] === name) continue;
    let proj = null;
    try { proj = /^\/\/ Projekt: (.+)$/m.exec(readFileSync(join(dir, f), 'utf8'))?.[1]?.trim() ?? null; } catch { /* unreadable */ }
    if (proj && samePath(proj, root)) out.push(m[1]);
  }
  return out;
}

// Enable and disable both remove the project's tasks under another name (legacyTasks): one task per project, and
// `close` still unregisters a task an earlier version created.
export function autostart(on, { root, script, dir }) {
  for (const old of legacyTasks(root, dir)) dropLegacy(old, dir);
  const f = autostartFiles({ root, script, dir });
  const { name } = f;
  if (on) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(f.shim, f.shimText);
    // UTF-16 z BOM: wscript czyta tak ścieżki spoza strony kodowej ANSI (np. polskie litery w nazwie użytkownika).
    if (process.platform === 'win32') writeFileSync(f.vbs, `\ufeff${f.vbsText}`, 'utf16le');
  }
  const drop = () => { rmSync(f.shim, { force: true }); rmSync(f.vbs, { force: true }); };
  const env = { DWMT_TASK: name, DWMT_VBS: winPath(f.vbs), DWMT_ROOT: winPath(root) };
  const winOn = `$a = New-ScheduledTaskAction -Execute "$env:SystemRoot\\System32\\wscript.exe" -Argument ('//B //Nologo "' + $env:DWMT_VBS + '"') -WorkingDirectory $env:DWMT_ROOT; $t = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME; $s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew; Register-ScheduledTask -TaskName $env:DWMT_TASK -Action $a -Trigger $t -Settings $s -Force | Out-Null`;
  const winOff = 'Unregister-ScheduledTask -TaskName $env:DWMT_TASK -Confirm:$false -ErrorAction SilentlyContinue';
  if (logged('autostart', { on, root, name, shim: fwdP(f.shim), ...(process.platform === 'win32' ? { ps: on ? winOn : winOff } : {}) })) { if (!on) drop(); return { ok: true, name, shim: fwdP(f.shim) }; }
  if (process.platform === 'win32') {
    const r = ps(on ? winOn : winOff, env);
    if (!on) drop();
    return { ok: r.status === 0, name, shim: fwdP(f.shim) };
  }
  if (process.platform === 'darwin') {
    const plist = join(homedir(), 'Library', 'LaunchAgents', `com.${name}.plist`);
    if (!on) { rmSync(plist, { force: true }); drop(); return { ok: true, name }; }
    mkdirSync(join(plist, '..'), { recursive: true });
    writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>com.${name}</string><key>ProgramArguments</key><array><string>${process.execPath}</string><string>${f.shim}</string><string>run</string></array><key>WorkingDirectory</key><string>${root}</string><key>RunAtLoad</key><true/></dict></plist>\n`);
    return { ok: true, name, shim: fwdP(f.shim) };
  }
  const unit = join(homedir(), '.config', 'systemd', 'user', `${name}.service`);
  if (!on) { run('systemctl', ['--user', 'disable', `${name}.service`]); rmSync(unit, { force: true }); drop(); return { ok: true, name }; }
  mkdirSync(join(unit, '..'), { recursive: true });
  writeFileSync(unit, `[Unit]\nDescription=dwmt supervisor ${root}\n[Service]\nWorkingDirectory=${root}\nExecStart=${process.execPath} ${f.shim} run\n[Install]\nWantedBy=default.target\n`);
  return { ok: run('systemctl', ['--user', 'enable', `${name}.service`]).status === 0, name, shim: fwdP(f.shim) };
}

// Removes the task (or launch agent, or user unit) and start files of an earlier version's name. Never throws.
function dropLegacy(name, dir) {
  const drop = () => { for (const ext of ['mjs', 'vbs']) rmSync(join(dir, `${name}.${ext}`), { force: true }); };
  if (logged('autostart-legacy', { on: false, name })) return drop();
  try {
    if (process.platform === 'win32') ps('Unregister-ScheduledTask -TaskName $env:DWMT_TASK -Confirm:$false -ErrorAction SilentlyContinue', { DWMT_TASK: name });
    else if (process.platform === 'darwin') rmSync(join(homedir(), 'Library', 'LaunchAgents', `com.${name}.plist`), { force: true });
    else {
      const unit = join(homedir(), '.config', 'systemd', 'user', `${name}.service`);
      if (existsSync(unit)) { run('systemctl', ['--user', 'disable', `${name}.service`]); rmSync(unit, { force: true }); }
    }
    drop();
  } catch { /* best effort: the new name is handled regardless */ }
}

// Preflight: które funkcje adaptera są dostępne na tym systemie (brak = ostrzeżenie; noc idzie bez nich).
export function platformWarnings() {
  if (process.env.DWMT_PLATFORM_LOG) return [];
  const has = (cmd, args = ['--version']) => run(cmd, args).status === 0;
  if (process.platform === 'win32') return [...(has('powershell', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major']) ? [] : ['brak PowerShell: bez powiadomień, czuwania i autostartu']), ...(existsSync(join(process.env.SystemRoot || 'C:/Windows', 'System32', 'wscript.exe')) ? [] : ['brak wscript.exe (VBScript wyłączony): autostart bez ukrytego okna nie wystartuje'])];
  if (process.platform === 'darwin') return existsSync('/usr/bin/caffeinate') ? [] : ['brak caffeinate: bez czuwania (ustaw zasilanie)'];
  return [...(has('systemd-inhibit') ? [] : ['brak systemd-inhibit: bez czuwania (ustaw zasilanie)']), ...(has('notify-send') ? [] : ['brak notify-send: bez powiadomień na pulpicie'])];
}
