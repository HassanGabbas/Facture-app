import test from 'node:test';
import assert from 'node:assert/strict';
import { handleExtract, LIMITS } from '../worker/handler.js';
import { createProxyProvider, createGeminiProvider, createProvider, isAiConfigured, extractDocumentData, AiError } from '../js/ai.js';
import { Store } from '../js/store.js';
import { _dictForTests, setLang, t, formatDate } from '../js/i18n.js';
import { DEFAULT_SETTINGS, newDocument, draftFromAi } from '../js/model.js';
import { documentTotals } from '../js/calc.js';

const ENV = { GEMINI_API_KEY: 'sk-test', APP_TOKEN: 'geheim' };

const modelReply = {
  dokumentenTyp: 'Rechnung', datum: '2027-01-05', faelligkeitsDatum: '2027-02-04', zahlungsbedingungen: '30 Tage nach Rechnungsdatum',
  gueltigBis: null, waehrung: 'MAD', kunde: { name: 'Société Atlas', adresse: 'Casablanca' },
  positionen: [{ artikelName: 'Kunstrasen', menge: 120, einheit: 'm²', einzelpreisNetto: 111, rabattNetto: 0, mwstSatz: 20 }],
  gesamtNetto: 13320, steuerBetrag: 2664, gesamtBrutto: 15984, vollstaendig: true, hinweise: [],
};

function req(body, { token = 'geheim', method = 'POST', origin } = {}) {
  return new Request('http://localhost/api/extract', {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(origin ? { Origin: origin } : {}) },
    body: method === 'POST' ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
  });
}

function fakeAnthropic(replyText, status = 200, seen = {}) {
  // Nachbildung der Gemini-API (Name historisch)
  return async (url, init) => {
    seen.url = url;
    seen.init = init;
    seen.body = JSON.parse(init.body);
    const ok = { candidates: [{ content: { parts: [{ text: replyText }] } }] };
    return new Response(JSON.stringify(status === 200 ? ok : { error: { message: 'x' } }), { status });
  };
}

test('Proxy: Erfolg, Datum im System-Prompt, Schlüssel nur serverseitig', async () => {
  const seen = {};
  const res = await handleExtract(req({ text: 'Rechnung ...', today: '2027-01-05' }), ENV, fakeAnthropic(JSON.stringify(modelReply), 200, seen));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(JSON.parse(body.result).kunde.name, 'Société Atlas');
  assert.equal(seen.init.headers['x-goog-api-key'], 'sk-test');
  assert.ok(seen.url.includes('generativelanguage.googleapis.com'));
  const system = seen.body.systemInstruction.parts[0].text;
  assert.ok(system.includes('2027-01-05'));
  assert.ok(!system.includes('{{TODAY}}'));
  assert.ok(!system.includes('2026-10-29'));
  assert.equal(seen.body.contents[0].parts[0].text, 'Rechnung ...');
  assert.equal(seen.body.generationConfig.responseMimeType, 'application/json');
  assert.ok(!JSON.stringify(body).includes('sk-test'));
});

test('Proxy: Zugangscode, Methode, Eingabegrenzen', async () => {
  const ok = fakeAnthropic('{}');
  assert.equal((await handleExtract(req({ text: 'x' }, { token: 'falsch' }), ENV, ok)).status, 401);
  assert.equal((await handleExtract(req({ text: 'x' }, { token: null }), ENV, ok)).status, 401);
  assert.equal((await handleExtract(req(null, { method: 'GET' }), ENV, ok)).status, 405);
  assert.equal((await handleExtract(req('kein json'), ENV, ok)).status, 400);
  assert.equal((await handleExtract(req({ text: '  ' }), ENV, ok)).status, 400);
  assert.equal((await handleExtract(req({ text: 'a'.repeat(LIMITS.textChars + 1) }), ENV, ok)).status, 413);
  assert.equal((await handleExtract(req({ text: 'x'.repeat(LIMITS.bodyBytes) }), ENV, ok)).status, 413);
});

test('Proxy: ohne Konfiguration wird nichts offen geliefert', async () => {
  const ok = fakeAnthropic('{}');
  assert.equal((await handleExtract(req({ text: 'x' }), { APP_TOKEN: 'a' }, ok)).status, 500);
  assert.equal((await handleExtract(req({ text: 'x' }), { GEMINI_API_KEY: 'k' }, ok)).status, 500);
  assert.equal((await handleExtract(req({ text: 'x' }, { token: null }), { GEMINI_API_KEY: 'k', ALLOW_NO_TOKEN: '1' }, ok)).status, 200);
});

test('Proxy: Fehler des Anbieters werden abgebildet, ohne Details preiszugeben', async () => {
  const r500 = await handleExtract(req({ text: 'x' }), ENV, fakeAnthropic('', 500));
  assert.equal(r500.status, 502);
  assert.equal((await handleExtract(req({ text: 'x' }), ENV, fakeAnthropic('', 429))).status, 429);
  const unreachable = await handleExtract(req({ text: 'x' }), ENV, async () => { throw new Error('boom'); });
  assert.equal(unreachable.status, 502);
  const empty = await handleExtract(req({ text: 'x' }), ENV, fakeAnthropic('   '));
  assert.equal(empty.status, 502);
});

test('Gemini direkt: Aufruf, Fehlerabbildung, Provider-Auswahl', async () => {
  const seen = {};
  const p = createGeminiProvider({ apiKey: 'MEIN-KEY', model: 'gemini-x', fetchImpl: fakeAnthropic(JSON.stringify(modelReply), 200, seen) });
  const result = await extractDocumentData(p, 'Rechnung ...', { today: '2027-01-05', lang: 'de' });
  assert.ok(result.ok);
  assert.ok(seen.url.includes('/models/gemini-x:generateContent'));
  assert.equal(seen.init.headers['x-goog-api-key'], 'MEIN-KEY');
  assert.ok(seen.body.systemInstruction.parts[0].text.includes('2027-01-05'));

  const failing = (status, message = 'x') => createGeminiProvider({ apiKey: 'k', fetchImpl: async () => new Response(JSON.stringify({ error: { message } }), { status }) });
  const call = (p2) => extractDocumentData(p2, 'text', { today: '2027-01-05', lang: 'de' });
  await assert.rejects(call(failing(400, 'API key not valid. Please pass a valid API key.')), (e) => e.kind === 'unauthorized');
  await assert.rejects(call(failing(403)), (e) => e.kind === 'unauthorized');
  await assert.rejects(call(failing(429)), (e) => e.kind === 'rate');
  await assert.rejects(call(failing(500)), (e) => e.kind === 'server');
  await assert.rejects(call(createGeminiProvider({ apiKey: 'k', fetchImpl: async () => { throw new TypeError('x'); } })), (e) => e.kind === 'network');
  await assert.rejects(call(createGeminiProvider({ apiKey: 'k', fetchImpl: async () => new Response(JSON.stringify({ candidates: [] }), { status: 200 }) })), (e) => e.kind === 'server');
  await assert.rejects(call(createGeminiProvider({ apiKey: '' })), (e) => e.kind === 'notConfigured');

  assert.equal(createProvider({ aiMode: 'direct', geminiKey: 'k' }).name, 'gemini-direct');
  assert.equal(createProvider({ aiMode: 'proxy', aiEndpoint: 'https://x' }).name, 'proxy');
  assert.equal(isAiConfigured({ aiMode: 'direct', geminiKey: '' }), false);
  assert.equal(isAiConfigured({ aiMode: 'direct', geminiKey: 'k' }), true);
  assert.equal(isAiConfigured({ aiMode: 'proxy', aiEndpoint: '', geminiKey: 'k' }), false);
});

test('Proxy: CORS nur für erlaubte Herkunft', async () => {
  const env = { ...ENV, ALLOWED_ORIGINS: 'https://app.example' };
  const good = await handleExtract(req({ text: 'x' }, { origin: 'https://app.example' }), env, fakeAnthropic('{}'));
  assert.equal(good.headers.get('Access-Control-Allow-Origin'), 'https://app.example');
  const bad = await handleExtract(req({ text: 'x' }, { origin: 'https://evil.example' }), env, fakeAnthropic('{}'));
  assert.equal(bad.headers.get('Access-Control-Allow-Origin'), null);
  const pre = await handleExtract(req(null, { method: 'OPTIONS', origin: 'https://app.example' }), env);
  assert.equal(pre.status, 204);
});

test('App-Provider -> Proxy -> Validierung -> Entwurf (Ende-zu-Ende mit Fake-Modell)', async () => {
  const fetchImpl = (url, init) => handleExtract(new Request(url, init), ENV, fakeAnthropic(JSON.stringify(modelReply)));
  const provider = createProxyProvider({ endpoint: 'http://localhost/api/extract', token: 'geheim', fetchImpl });
  const result = await extractDocumentData(provider, 'Rechnung für Société Atlas ...', { today: '2027-01-05', lang: 'de' });
  assert.ok(result.ok, JSON.stringify(result.errors));
  const doc = draftFromAi(result.data, { ...DEFAULT_SETTINGS }, '2027-01-05');
  assert.equal(documentTotals(doc.lines).gross, 1598400n);
  assert.deepEqual(doc.hints, []);
});

test('App-Provider: Modell-Antwort mit Fließtext wird als ungültig gemeldet', async () => {
  const fetchImpl = (url, init) => handleExtract(new Request(url, init), ENV, fakeAnthropic('Das kann ich leider nicht.'));
  const provider = createProxyProvider({ endpoint: 'http://localhost/api/extract', token: 'geheim', fetchImpl });
  const result = await extractDocumentData(provider, 'irgendwas', { today: '2027-01-05', lang: 'de' });
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'notJson');
});

test('App-Provider: Fehlerarten', async () => {
  const mk = (fetchImpl, endpoint = 'http://x/api') => createProxyProvider({ endpoint, fetchImpl });
  const call = (p) => extractDocumentData(p, 'text', { today: '2027-01-05', lang: 'de' });
  const status = (s) => async () => new Response('{}', { status: s });
  await assert.rejects(call(mk(status(401))), (e) => e instanceof AiError && e.kind === 'unauthorized');
  await assert.rejects(call(mk(status(429))), (e) => e.kind === 'rate');
  await assert.rejects(call(mk(status(502))), (e) => e.kind === 'server');
  await assert.rejects(call(mk(async () => { throw new TypeError('offline'); })), (e) => e.kind === 'network');
  await assert.rejects(call(mk(async () => new Response('<html>', { status: 200 }))), (e) => e.kind === 'response');
  await assert.rejects(call(mk(async () => new Response('{"foo":1}', { status: 200 }))), (e) => e.kind === 'response');
  await assert.rejects(call(mk(status(200), '')), (e) => e.kind === 'notConfigured');
  await assert.rejects(extractDocumentData(mk(status(200)), '   ', {}), (e) => e.kind === 'response');
  await assert.rejects(extractDocumentData(mk(status(200)), 'a'.repeat(5000), {}), (e) => e.kind === 'tooLong');
});

class MemoryStorage {
  constructor() { this.m = new Map(); }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { this.m.set(k, String(v)); }
}

test('Speicher: Dokumente überleben einen Neustart (neues Store-Objekt, gleicher Speicher)', () => {
  const backing = new MemoryStorage();
  const a = new Store(backing);
  const doc = newDocument('invoice', DEFAULT_SETTINGS, '2027-01-05');
  doc.customer = { name: 'Atlas', address: 'Casablanca' };
  a.saveDocument(doc);
  a.upsertCustomer(doc.customer);
  const b = new Store(backing);
  assert.equal(b.listDocuments().length, 1);
  assert.equal(b.getDocument(doc.id).customer.name, 'Atlas');
  assert.equal(b.listCustomers()[0].address, 'Casablanca');
  b.deleteDocument(doc.id);
  assert.equal(new Store(backing).listDocuments().length, 0);
});

test('Speicher: fortlaufende Nummern je Typ und Jahr', () => {
  const s = new Store(new MemoryStorage());
  assert.equal(s.nextNumber('invoice', 2027, DEFAULT_SETTINGS), 'RE-2027-0001');
  assert.equal(s.nextNumber('invoice', 2027, DEFAULT_SETTINGS), 'RE-2027-0002');
  assert.equal(s.nextNumber('quote', 2027, DEFAULT_SETTINGS), 'AN-2027-0001');
  assert.equal(s.nextNumber('invoice', 2028, DEFAULT_SETTINGS), 'RE-2028-0001');
});

test('Speicher: Sicherung enthält kein Zugangstoken, Wiederherstellung funktioniert', () => {
  const backing = new MemoryStorage();
  const s = new Store(backing);
  s.saveSettings({ ...DEFAULT_SETTINGS, aiToken: 'geheim', geminiKey: 'AIza-geheim', company: { ...DEFAULT_SETTINGS.company, name: 'Meine Firma' } });
  s.saveDocument(newDocument('quote', DEFAULT_SETTINGS, '2027-01-05'));
  const data = s.exportAll();
  assert.equal(data.settings.aiToken, '');
  assert.equal(data.settings.geminiKey, '');
  assert.ok(!JSON.stringify(data).includes('geheim'));
  const other = new Store(new MemoryStorage());
  other.importAll(JSON.parse(JSON.stringify(data)));
  assert.equal(other.listDocuments().length, 1);
  assert.equal(other.getSettings().company.name, 'Meine Firma');
  assert.throws(() => other.importAll({ foo: 1 }), /invalidBackup/);
});

test('Speicher: defekte Daten führen nicht zum Absturz', () => {
  const backing = new MemoryStorage();
  backing.setItem('ra.docs.v1', '{kaputt');
  assert.deepEqual(new Store(backing).listDocuments(), []);
});

test('Übersetzungen: Deutsch und Französisch haben dieselben Schlüssel', () => {
  const de = Object.keys(_dictForTests.de).sort();
  const fr = Object.keys(_dictForTests.fr).sort();
  assert.deepEqual(de.filter((k) => !fr.includes(k)), [], 'fehlt auf Französisch');
  assert.deepEqual(fr.filter((k) => !de.includes(k)), [], 'fehlt auf Deutsch');
  setLang('fr');
  assert.equal(t('hint_priceMissing', { line: 2 }), 'Ligne 2 : prix unitaire manquant.');
  assert.equal(formatDate('2027-01-05', 'fr'), '05/01/2027');
  setLang('de');
  assert.equal(formatDate('2027-01-05', 'de'), '05.01.2027');
});
