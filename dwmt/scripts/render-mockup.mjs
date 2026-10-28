#!/usr/bin/env node
// dwmt X7: render makiet HTML do PNG. Playwright pochodzi z projektu (cwd = ui.playwright z configu), dwmt zostaje bez zależności.
// Wejście: plik JSON { viewport: [w, h], css, jobs: [{ id, html, state, out }] }. Wyjście: JSON { ok, results: [{ id, ok, error }] }.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const print = (o) => console.log(JSON.stringify(o));
const spec = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const req = createRequire(join(process.cwd(), 'package.json'));
let pw = null;
for (const m of ['@playwright/test', 'playwright', 'playwright-core']) {
  try { pw = req(m); break; } catch { /* następny pakiet */ }
}
if (!pw?.chromium) {
  print({ ok: false, error: `no @playwright/test or playwright resolvable from ${process.cwd()} (ui.playwright in .claude/dwmt.json; npm install?)` });
  process.exit(0);
}

const [width, height] = spec.viewport || [1440, 900];
const results = [];
let browser;
try {
  browser = await pw.chromium.launch();
  for (const job of spec.jobs) {
    const page = await browser.newPage({ viewport: { width, height } });
    try {
      await page.goto(pathToFileURL(job.html).href, { waitUntil: 'load', timeout: 30_000 });
      // Makiety ładują fonty z sieci: czekamy krótko, bez sieci render idzie z fontem zastępczym.
      await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
      if (spec.css) await page.addStyleTag({ content: spec.css });
      if (job.state) await page.evaluate(job.state);
      await page.evaluate(() => document.fonts?.ready);
      await page.waitForTimeout(300);
      await page.screenshot({ path: job.out, animations: 'disabled' });
      results.push({ id: job.id, ok: true });
    } catch (e) {
      results.push({ id: job.id, ok: false, error: String(e.message || e).split('\n')[0].slice(0, 300) });
    } finally { await page.close(); }
  }
  print({ ok: results.every((r) => r.ok), results });
} catch (e) {
  print({ ok: false, error: `chromium: ${String(e.message || e).split('\n')[0].slice(0, 300)}` });
} finally { await browser?.close(); }
