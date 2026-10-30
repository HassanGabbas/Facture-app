// Ende-zu-Ende-Test im echten Browser (Chromium via Playwright). Nicht Teil von "npm test".
//   node tests/e2e/ui.e2e.mjs            (Playwright muss installiert sein: npm i -D playwright)
// Der KI-Proxy wird im Browser per Route-Mock ersetzt; der Proxy selbst ist in tests/integration.test.js abgedeckt.
import { spawn } from 'node:child_process';
import { mkdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import assert from 'node:assert/strict';

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  ({ chromium } = await import('/opt/npm-tools/node_modules/playwright/index.mjs'));
}

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const OUT = process.env.E2E_OUT || join(ROOT, 'tests', 'e2e', 'out');
mkdirSync(OUT, { recursive: true });
const PORT = 8091;
const BASE = `http://127.0.0.1:${PORT}`;

const server = spawn('node', ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' }, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));

const modelResult = {
  dokumentenTyp: 'Rechnung', datum: '2026-10-29', faelligkeitsDatum: '2026-11-28', zahlungsbedingungen: '30 Tage nach Rechnungsdatum',
  gueltigBis: null, waehrung: 'MAD', kunde: { name: 'Société Atlas', adresse: 'Casablanca' },
  positionen: [
    { artikelName: 'Kunstrasen', menge: 120, einheit: 'm²', einzelpreisNetto: 111, rabattNetto: 0, mwstSatz: 20 },
    { artikelName: 'Transport pauschal', menge: 1, einheit: null, einzelpreisNetto: null, rabattNetto: 0, mwstSatz: 20 },
  ],
  gesamtNetto: null, steuerBetrag: null, gesamtBrutto: null, vollstaendig: false, hinweise: ['Preis für Transport fehlt'],
};

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, acceptDownloads: true });
const page = await context.newPage();
const problems = [];
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
page.on('dialog', (d) => d.accept());

let step = 0;
const ok = (msg) => console.log(`  ✓ ${++step}. ${msg}`);

try {
  // 1. Start, Hinweis auf fehlende Einstellungen
  await page.goto(BASE);
  await page.waitForSelector('#main h1');
  assert.match(await page.textContent('#main'), /Bitte zuerst die Firmendaten/);
  ok('Dashboard lädt, Hinweis auf fehlende Einstellungen');

  // 2. Einstellungen
  await page.click('#nav a[href="#/settings"]');
  await page.fill('[name=companyName]', 'Gazon Pro SARL');
  await page.fill('[name=companyAddress]', 'Rue 1, Casablanca');
  await page.selectOption('[name=currency]', 'MAD');
  await page.fill('[name=defaultTaxRate]', '20');
  await page.selectOption('[name=aiMode]', 'proxy');
  await page.fill('[name=aiEndpoint]', `${BASE}/api/extract`);
  await page.fill('[name=aiToken]', 't');
  await page.click('#settingsForm button[type=submit]');
  await page.waitForSelector('.toast.show.ok');
  ok('Einstellungen gespeichert');

  // 3. KI-Route mocken
  let aiRequest = null;
  await page.route('**/api/extract', async (route) => {
    aiRequest = { headers: route.request().headers(), body: JSON.parse(route.request().postData()) };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ result: JSON.stringify(modelResult) }) });
  });

  // 4. Neue Rechnung per Freitext
  await page.goto(`${BASE}/#/new/invoice`);
  await page.waitForSelector('#aiText');
  await page.fill('#aiText', 'Rechnung für Société Atlas in Casablanca: 120 m² Kunstrasen zu 111 DH HT, Transport pauschal, 20 % TVA, 30 Tage');
  await page.click('#aiRun');
  await page.waitForSelector('#hints');
  assert.equal(aiRequest.headers.authorization, 'Bearer t');
  assert.match(aiRequest.body.text, /Société Atlas/);
  assert.match(aiRequest.body.today, /^\d{4}-\d{2}-\d{2}$/);
  const hints = await page.textContent('#hints');
  assert.match(hints, /Preis für Transport fehlt/);
  assert.match(hints, /Position 2: Einzelpreis fehlt/);
  assert.equal(await page.inputValue('[data-f="customer.name"]'), 'Société Atlas');
  assert.equal(await page.inputValue('[data-line="0"][data-f="price"]'), '111');
  assert.equal(await page.inputValue('[data-f="currency"]'), 'MAD');
  assert.match(await page.textContent('#totals'), /–/); // unvollständig -> keine erfundene Summe
  await page.screenshot({ path: join(OUT, '1-editor-ki-ergebnis.png'), fullPage: true });
  ok('KI-Ergebnis übernommen, Hinweise sichtbar, Summe bleibt "–" bei fehlendem Preis');

  // 5. Unvollständig kann nicht fertiggestellt werden
  await page.click('[data-action="finalize"]');
  await page.waitForSelector('.notice.error');
  const issues = await page.textContent('#issues');
  assert.match(issues, /Position 2: Einzelpreis fehlt/);
  assert.match(issues, /Hinweise oben prüfen/);
  assert.ok(await page.$('.line.invalid'));
  assert.equal(await page.evaluate(() => location.hash.startsWith('#/preview')), false);
  ok('Fertigstellen blockiert (Preis fehlt, Hinweise nicht bestätigt)');

  // 6. Korrigieren, bestätigen, fertigstellen
  await page.fill('[data-line="1"][data-f="price"]', '500');
  await page.check('[data-reviewed]');
  const totals = await page.textContent('#totals');
  assert.match(totals, /13\.820,00/);
  assert.match(totals, /2\.764,00/);
  assert.match(totals, /16\.584,00/);
  await page.click('[data-action="finalize"]');
  await page.waitForURL(/#\/preview\//);
  const sheet = await page.textContent('#sheet');
  assert.match(sheet, /RE-\d{4}-0001/);
  assert.match(sheet, /Société Atlas/);
  assert.match(sheet, /16\.584,00/);
  assert.match(sheet, /Gazon Pro SARL/);
  assert.equal(await page.$('.wm'), null);
  await page.screenshot({ path: join(OUT, '2-vorschau.png'), fullPage: true });
  ok('Rechnung fertiggestellt: Nummer RE-…-0001, Summen 13.820,00 / 2.764,00 / 16.584,00 MAD');

  // 7. PDF aus der Druckansicht
  await page.pdf({ path: join(OUT, 'rechnung.pdf'), format: 'A4', printBackground: true });
  assert.ok(statSync(join(OUT, 'rechnung.pdf')).size > 5000);
  ok('PDF aus Druckansicht erzeugt');

  // 8. Persistenz nach Neuladen
  await page.goto(`${BASE}/#/docs`);
  await page.reload();
  await page.waitForSelector('.docs .doc');
  const list = await page.textContent('.docs');
  assert.match(list, /RE-\d{4}-0001/);
  assert.match(list, /16\.584,00/);
  ok('Dokument nach Neuladen weiterhin in der Liste');

  // 9. Angebot von Hand, ohne KI
  await page.goto(`${BASE}/#/new/quote`);
  await page.fill('[data-f="customer.name"]', 'Café Médina');
  await page.fill('[data-line="0"][data-f="name"]', 'Beratung');
  await page.fill('[data-line="0"][data-f="qty"]', '2,5');
  await page.fill('[data-line="0"][data-f="unit"]', 'Std');
  await page.fill('[data-line="0"][data-f="price"]', '80');
  await page.selectOption('[data-line="0"][data-f="discountType"]', 'percent');
  await page.fill('[data-line="0"][data-f="discount"]', '10');
  assert.equal(await page.inputValue('[data-line="0"][data-f="taxRate"]'), '20'); // Standardsatz aus Einstellungen
  assert.match(await page.textContent('#totals'), /216,00/); // 2,5×80=200, −10 % = 180 netto, +20 % = 216 brutto
  assert.match(await page.textContent('[data-line-net="0"]'), /180,00/);
  await page.click('[data-action="finalize"]');
  await page.waitForURL(/#\/preview\//);
  assert.match(await page.textContent('#sheet'), /AN-\d{4}-0001/);
  assert.match(await page.textContent('#sheet'), /Gültig bis/);
  ok('Angebot von Hand: Rabatt %, Standardsteuersatz, Nummer AN-…-0001, ohne Fälligkeitsdatum');

  // 10. Entwurf wird beim Verlassen automatisch gesichert
  await page.goto(`${BASE}/#/new/invoice`);
  await page.fill('[data-f="customer.name"]', 'Nur Entwurf GmbH');
  await page.goto(`${BASE}/#/docs`);
  await page.waitForSelector('.docs .doc');
  assert.match(await page.textContent('.docs'), /Nur Entwurf GmbH/);
  assert.match(await page.textContent('.docs'), /Entwurf/);
  ok('Entwurf beim Verlassen automatisch gespeichert');

  // 11. Offline: Service Worker, Anzeigen und Bearbeiten
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await page.waitForTimeout(500);
  await context.setOffline(true);
  await page.goto(`${BASE}/#/docs`);
  await page.reload();
  await page.waitForSelector('.docs .doc');
  assert.match(await page.textContent('#online'), /Offline/);
  await page.click('.docs .doc a.doc-main >> nth=0');
  await page.waitForSelector('[data-f="customer.name"]');
  await page.fill('[data-f="notes"]', 'Offline bearbeitet');
  await page.click('[data-action="save-draft"]');
  await page.waitForSelector('.toast.show.ok');
  await page.fill('#aiText', 'Rechnung für Test');
  await page.click('#aiRun');
  await page.waitForSelector('#aiStatus.msg');
  assert.match(await page.textContent('#aiStatus'), /offline/i);
  ok('Offline: App startet, Dokumente öffnen und bearbeiten funktioniert, KI meldet ehrlich "offline"');
  await context.setOffline(false);

  // 12. Französisch
  await page.goto(`${BASE}/#/settings`);
  await page.selectOption('[name=lang]', 'fr');
  await page.click('#settingsForm button[type=submit]');
  await page.waitForSelector('.toast.show.ok');
  assert.match(await page.textContent('#nav'), /Réglages/);
  await page.goto(`${BASE}/#/docs`);
  await page.waitForSelector('.docs .doc');
  assert.match(await page.textContent('#main'), /Documents enregistrés/);
  ok('Sprache Französisch umgeschaltet');

  // 13. Sicherung
  await page.goto(`${BASE}/#/settings`);
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('[data-action="export"]')]);
  assert.match(download.suggestedFilename(), /sicherung.*\.json$/);
  ok('Sicherungsdatei wird heruntergeladen');

  const real = problems.filter((p) => !/Failed to load resource/.test(p));
  assert.deepEqual(real, [], `Browserfehler: ${real.join(' | ')}`);
  ok('keine JavaScript-Fehler im Browser');
  console.log(`\nAlle ${step} Prüfungen bestanden. Ausgaben in ${OUT}`);
} catch (e) {
  await page.screenshot({ path: join(OUT, 'fehler.png'), fullPage: true }).catch(() => {});
  console.error(`\nFEHLER nach Schritt ${step}:`, e.message);
  console.error(problems.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.kill();
}
