import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateAiResponse, draftFromAi, checkDocument, hasErrors, addDays, isValidIsoDate, normalizeCurrency,
  parsePaymentDays, DEFAULT_SETTINGS, extractJson, formatNumber, newDocument, compareAiTotals,
} from '../js/model.js';
import { documentTotals } from '../js/calc.js';

const TODAY = '2026-10-29';
const settings = { ...DEFAULT_SETTINGS, defaultTaxRate: '' };

const aiOk = () => ({
  dokumentenTyp: 'Rechnung',
  datum: TODAY,
  faelligkeitsDatum: '2026-11-28',
  zahlungsbedingungen: '30 Tage nach Rechnungsdatum',
  gueltigBis: null,
  waehrung: 'MAD',
  kunde: { name: 'Société Atlas', adresse: 'Casablanca' },
  positionen: [
    { artikelName: 'Kunstrasen', menge: 120, einheit: 'm²', einzelpreisNetto: 111, rabattNetto: 0, mwstSatz: 20,
      gesamtpreisNettoPosition: 13320, steuerBetragPosition: 2664, gesamtpreisBruttoPosition: 15984 },
    { artikelName: 'Transport', menge: 1, einheit: null, einzelpreisNetto: 500, rabattNetto: 0, mwstSatz: 20,
      gesamtpreisNettoPosition: 500, steuerBetragPosition: 100, gesamtpreisBruttoPosition: 600 },
  ],
  gesamtNetto: 13820,
  steuerBetrag: 2764,
  gesamtBrutto: 16584,
  vollstaendig: true,
  hinweise: [],
});

test('Datumshelfer', () => {
  assert.equal(addDays('2026-10-29', 14), '2026-11-12');
  assert.equal(addDays('2026-12-25', 10), '2027-01-04');
  assert.ok(isValidIsoDate('2026-02-28'));
  assert.ok(!isValidIsoDate('2026-02-30'));
  assert.ok(!isValidIsoDate('29.10.2026'));
});

test('Währungen und Zahlungsfristen', () => {
  assert.equal(normalizeCurrency('DH'), 'MAD');
  assert.equal(normalizeCurrency('€'), 'EUR');
  assert.equal(normalizeCurrency('chf'), 'CHF');
  assert.equal(normalizeCurrency('Muscheln'), null);
  assert.deepEqual(parsePaymentDays('30 Tage nach Rechnungsdatum'), { days: 30, fromReceipt: false });
  assert.deepEqual(parsePaymentDays('30 Tage nach Rechnungserhalt'), { days: 30, fromReceipt: true });
  assert.deepEqual(parsePaymentDays('payable sous 15 jours'), { days: 15, fromReceipt: false });
  assert.equal(parsePaymentDays('sofort'), null);
});

test('extractJson entfernt Codeblöcke und Begleittext', () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('Hier: {"a":1} Ende'), { a: 1 });
  assert.equal(extractJson('kein json'), null);
  assert.equal(extractJson('{kaputt'), null);
});

test('validateAiResponse akzeptiert gültige Antwort', () => {
  const r = validateAiResponse(JSON.stringify(aiOk()));
  assert.ok(r.ok, JSON.stringify(r.errors));
});

test('validateAiResponse meldet Typfehler und Pflichtfelder', () => {
  const bad = aiOk();
  bad.dokumentenTyp = 'Lieferschein';
  bad.positionen[0].menge = '120';
  bad.positionen[1].artikelName = '';
  bad.datum = '2026-13-45';
  const r = validateAiResponse(bad);
  assert.ok(!r.ok);
  const paths = r.errors.map((e) => e.path);
  assert.ok(paths.includes('dokumentenTyp'));
  assert.ok(paths.includes('positionen[0].menge'));
  assert.ok(paths.includes('positionen[1].artikelName'));
  assert.ok(paths.includes('datum'));
  assert.equal(validateAiResponse('Entschuldigung, das kann ich nicht.').errors[0].code, 'notJson');
  assert.ok(!validateAiResponse({ dokumentenTyp: 'Rechnung', datum: TODAY }).ok);
});

test('draftFromAi: Beispiel Société Atlas', () => {
  const doc = draftFromAi(aiOk(), settings, TODAY);
  assert.equal(doc.type, 'invoice');
  assert.equal(doc.currency, 'MAD');
  assert.equal(doc.dueDate, '2026-11-28');
  assert.equal(doc.lines.length, 2);
  assert.equal(doc.lines[0].unit, 'm²');
  assert.equal(doc.lines[1].unit, '');
  const t = documentTotals(doc.lines);
  assert.equal(t.gross, 1658400n);
  assert.deepEqual(doc.hints, []);
  assert.ok(!hasErrors(checkDocument(doc)));
});

test('draftFromAi: Summen der KI werden gegengeprüft', () => {
  const ai = aiOk();
  ai.gesamtBrutto = 99999;
  const doc = draftFromAi(ai, settings, TODAY);
  assert.ok(doc.hints.some((h) => h.code === 'aiTotalsMismatch'));
  assert.deepEqual(compareAiTotals(ai, documentTotals(doc.lines)), ['gesamtBrutto']);
});

test('draftFromAi: fehlender Preis und Steuersatz werden markiert und blockieren das Fertigstellen', () => {
  const ai = aiOk();
  ai.positionen[1].einzelpreisNetto = null;
  ai.positionen[1].mwstSatz = null;
  const doc = draftFromAi(ai, settings, TODAY);
  const codes = doc.hints.map((h) => h.code);
  assert.ok(codes.includes('priceMissing'));
  assert.ok(codes.includes('taxMissing'));
  const issues = checkDocument(doc);
  assert.ok(hasErrors(issues));
  assert.ok(issues.some((i) => i.code === 'linePriceMissing' && i.params.line === 2));
  assert.ok(issues.some((i) => i.code === 'lineTaxMissing'));
  assert.ok(issues.some((i) => i.code === 'hintsNotReviewed'));
});

test('draftFromAi: Standardsteuersatz aus Einstellungen wird sichtbar gekennzeichnet', () => {
  const ai = aiOk();
  ai.positionen[0].mwstSatz = null;
  const doc = draftFromAi(ai, { ...settings, defaultTaxRate: '19' }, TODAY);
  assert.equal(doc.lines[0].taxRate, '19');
  assert.ok(doc.hints.some((h) => h.code === 'defaultTaxApplied' && h.params.line === 1));
});

test('Hinweise müssen bestätigt werden, danach ist Fertigstellen möglich', () => {
  const ai = aiOk();
  ai.hinweise = ['Kundenadresse unklar'];
  const doc = draftFromAi(ai, settings, TODAY);
  assert.ok(hasErrors(checkDocument(doc)));
  doc.reviewed = true;
  assert.ok(!hasErrors(checkDocument(doc)));
});

test('Fälligkeit: Frist ab Rechnungserhalt wird nicht geraten', () => {
  const ai = aiOk();
  ai.faelligkeitsDatum = null;
  ai.zahlungsbedingungen = '30 Tage nach Rechnungserhalt';
  const doc = draftFromAi(ai, settings, TODAY);
  assert.equal(doc.dueDate, '');
  assert.ok(doc.hints.some((h) => h.code === 'dueFromReceipt'));
  assert.ok(checkDocument(doc).some((i) => i.code === 'dueMissing'));
});

test('Fälligkeit wird aus Rechnungsdatum und Frist berechnet', () => {
  const ai = aiOk();
  ai.faelligkeitsDatum = null;
  ai.zahlungsbedingungen = '14 Tage nach Rechnungsdatum';
  assert.equal(draftFromAi(ai, settings, TODAY).dueDate, '2026-11-12');
});

test('Angebot: kein Fälligkeitsdatum, Gültigkeit aus Einstellung mit Hinweis', () => {
  const ai = aiOk();
  ai.dokumentenTyp = 'Angebot';
  ai.faelligkeitsDatum = null;
  ai.zahlungsbedingungen = null;
  const doc = draftFromAi(ai, settings, TODAY);
  assert.equal(doc.type, 'quote');
  assert.equal(doc.dueDate, '');
  assert.equal(doc.validUntil, '2026-11-28');
  assert.ok(doc.hints.some((h) => h.code === 'defaultValidityApplied'));
});

test('checkDocument: Kunde, Zeilenfehler, Rabatt zu hoch', () => {
  const doc = newDocument('invoice', { ...settings, defaultTaxRate: '20' }, TODAY);
  let codes = checkDocument(doc).map((i) => i.code);
  assert.ok(codes.includes('customerMissing'));
  assert.ok(codes.includes('lineNameMissing'));
  assert.ok(codes.includes('linePriceMissing'));

  doc.customer.name = 'Test';
  doc.lines = [{ id: 'x', name: 'A', qty: '1', unit: '', price: '10', discountType: 'amount', discount: '15', taxRate: '20' }];
  codes = checkDocument(doc).map((i) => i.code);
  assert.ok(codes.includes('lineDiscountTooHigh'));

  doc.lines[0].discount = '5';
  assert.ok(!hasErrors(checkDocument(doc)));

  doc.dueDate = '2026-10-01';
  assert.ok(checkDocument(doc).some((i) => i.code === 'dueBeforeDate'));
});

test('Dokumentnummern', () => {
  assert.equal(formatNumber('RE', 2026, 7), 'RE-2026-0007');
});
