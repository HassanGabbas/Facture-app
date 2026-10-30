// Datenmodell, Validierung der KI-Antwort und Prüfregeln für Dokumente.
import { PCT_SCALE, documentTotals, lineAmounts, numberToInput, parseDecimal, QTY_SCALE, PRICE_SCALE } from './calc.js';

export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const DEFAULT_SETTINGS = {
  lang: 'de',
  currency: 'EUR',
  defaultTaxRate: '', // bewusst leer: der Satz hängt vom Land ab und wird nicht geraten
  invoicePrefix: 'RE',
  quotePrefix: 'AN',
  defaultPaymentDays: 14,
  quoteValidDays: 30,
  company: { name: '', address: '', ice: '', ifNr: '', email: '', phone: '', bank: '' },
  logo: '', // Data-URL des Firmenlogos (verkleinert)
  logoPosition: 'right', // 'right' = rechts gegenüber dem Firmennamen, 'above' = über dem Firmennamen
  aiMode: 'direct', // 'direct' = Gemini-Schlüssel im Gerät, 'proxy' = eigener Proxy
  geminiKey: '',
  geminiModel: '',
  aiEndpoint: '',
  aiToken: '',
};

// ---------- Datum ----------

export function isValidIsoDate(s) {
  if (typeof s !== 'string' || !ISO_DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function addDays(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function todayIso(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/** Liest eine Frist in Tagen aus dem Text. Gibt { days, fromReceipt } oder null zurück. */
export function parsePaymentDays(text) {
  if (typeof text !== 'string') return null;
  const m = /(\d{1,3})\s*(tage|tagen|jours|jour|days|day|j\b)/i.exec(text);
  if (!m) return null;
  const fromReceipt = /(erhalt|empfang|zugang|réception|reception|receipt|livraison)/i.test(text);
  return { days: Number(m[1]), fromReceipt };
}

// ---------- Währung ----------

export function normalizeCurrency(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim().toUpperCase().replace(/\./g, '');
  if (['EUR', '€', 'EURO', 'EUROS'].includes(v)) return 'EUR';
  if (['MAD', 'DH', 'DHS', 'DIRHAM', 'DIRHAMS'].includes(v)) return 'MAD';
  if (['USD', '$', 'DOLLAR', 'US$'].includes(v)) return 'USD';
  return /^[A-Z]{3}$/.test(v) ? v : null;
}

// ---------- Dokument ----------

let idCounter = 0;
export function newId(prefix = 'id') {
  idCounter += 1;
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${idCounter}${rand}`;
}

export function emptyLine(settings = DEFAULT_SETTINGS) {
  return {
    id: newId('l'),
    name: '',
    qty: '1',
    unit: '',
    price: '',
    discountType: 'amount',
    discount: '',
    taxRate: settings.defaultTaxRate || '',
  };
}

export function newDocument(type, settings = DEFAULT_SETTINGS, today = todayIso()) {
  const isInvoice = type === 'invoice';
  const days = Number(settings.defaultPaymentDays) || 14;
  return {
    id: newId('d'),
    type,
    status: 'draft',
    number: '',
    date: today,
    dueDate: isInvoice ? addDays(today, days) : '',
    validUntil: isInvoice ? '' : addDays(today, Number(settings.quoteValidDays) || 30),
    paymentTerms: isInvoice ? `${days} Tage nach Rechnungsdatum` : '',
    currency: settings.currency || 'EUR',
    customer: { name: '', address: '', ice: '' },
    showDiscount: false, // Rabatt-Spalte nur auf Wunsch (Dokument-Einstellung)
    lines: [emptyLine(settings)],
    notes: '',
    hints: [],
    reviewed: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

// ---------- KI-Antwort prüfen ----------

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isStrOrNull = (v) => v === null || typeof v === 'string';
const isNumOrNull = (v) => v === null || isNum(v);

/** Entfernt Markdown-Codeblöcke und Text um das JSON, falls die KI sich nicht an das Format hält. */
export function extractJson(text) {
  if (typeof text !== 'string') return null;
  let s = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)```$/i.exec(s);
  if (fence) s = fence[1].trim();
  if (!s.startsWith('{')) {
    const a = s.indexOf('{');
    const b = s.lastIndexOf('}');
    if (a === -1 || b <= a) return null;
    s = s.slice(a, b + 1);
  }
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/**
 * Prüft Struktur und Datentypen der KI-Antwort.
 * Gibt { ok, data, errors } zurück; errors enthält { path, code } ohne Fließtext (Anzeige übersetzt die App).
 */
export function validateAiResponse(raw) {
  const errors = [];
  const add = (path, code) => errors.push({ path, code });

  const data = typeof raw === 'string' ? extractJson(raw) : raw;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, data: null, errors: [{ path: '', code: 'notJson' }] };
  }

  if (!['Rechnung', 'Angebot'].includes(data.dokumentenTyp)) add('dokumentenTyp', 'invalidValue');
  if (!isStrOrNull(data.datum ?? null) || (data.datum && !isValidIsoDate(data.datum))) add('datum', 'invalidDate');
  if (!isStrOrNull(data.faelligkeitsDatum ?? null) || (data.faelligkeitsDatum && !isValidIsoDate(data.faelligkeitsDatum))) {
    add('faelligkeitsDatum', 'invalidDate');
  }
  if (!isStrOrNull(data.gueltigBis ?? null) || (data.gueltigBis && !isValidIsoDate(data.gueltigBis))) {
    add('gueltigBis', 'invalidDate');
  }
  if (!isStrOrNull(data.zahlungsbedingungen ?? null)) add('zahlungsbedingungen', 'wrongType');
  if (!isStrOrNull(data.waehrung ?? null)) add('waehrung', 'wrongType');

  if (data.kunde === null || typeof data.kunde !== 'object' || Array.isArray(data.kunde)) {
    add('kunde', 'missingField');
  } else {
    if (!isStrOrNull(data.kunde.name ?? null)) add('kunde.name', 'wrongType');
    if (!isStrOrNull(data.kunde.adresse ?? null)) add('kunde.adresse', 'wrongType');
  }

  if (!Array.isArray(data.positionen)) {
    add('positionen', 'missingField');
  } else {
    data.positionen.forEach((p, i) => {
      const at = (f) => `positionen[${i}].${f}`;
      if (!p || typeof p !== 'object') return add(`positionen[${i}]`, 'wrongType');
      if (typeof p.artikelName !== 'string' || p.artikelName.trim() === '') add(at('artikelName'), 'missingField');
      if (!isNumOrNull(p.menge ?? null)) add(at('menge'), 'wrongType');
      if (!isStrOrNull(p.einheit ?? null)) add(at('einheit'), 'wrongType');
      if (!isNumOrNull(p.einzelpreisNetto ?? null)) add(at('einzelpreisNetto'), 'wrongType');
      if (!isNumOrNull(p.rabattNetto ?? null)) add(at('rabattNetto'), 'wrongType');
      if (!isNumOrNull(p.mwstSatz ?? null)) add(at('mwstSatz'), 'wrongType');
      if (isNum(p.menge) && p.menge <= 0) add(at('menge'), 'notPositive');
      if (isNum(p.einzelpreisNetto) && p.einzelpreisNetto < 0) add(at('einzelpreisNetto'), 'negative');
      if (isNum(p.mwstSatz) && (p.mwstSatz < 0 || p.mwstSatz > 100)) add(at('mwstSatz'), 'outOfRange');
    });
  }

  for (const f of ['gesamtNetto', 'steuerBetrag', 'gesamtBrutto']) {
    if (!isNumOrNull(data[f] ?? null)) add(f, 'wrongType');
  }
  if (data.hinweise !== undefined && !(Array.isArray(data.hinweise) && data.hinweise.every((h) => typeof h === 'string'))) {
    add('hinweise', 'wrongType');
  }
  if (data.vollstaendig !== undefined && typeof data.vollstaendig !== 'boolean') add('vollstaendig', 'wrongType');

  return { ok: errors.length === 0, data: errors.length === 0 ? data : null, errors };
}

// ---------- KI-Antwort -> Dokumententwurf ----------

/**
 * Baut aus der geprüften KI-Antwort einen bearbeitbaren Entwurf.
 * Alle Hinweise (von der KI und von der App) landen in doc.hints und müssen vor dem Fertigstellen bestätigt werden.
 * hint: { code, params?, text? } – "text" nur für Originalhinweise der KI.
 */
export function draftFromAi(ai, settings = DEFAULT_SETTINGS, today = todayIso()) {
  const type = ai.dokumentenTyp === 'Angebot' ? 'quote' : 'invoice';
  const base = newDocument(type, settings, today);
  const hints = [];

  const doc = { ...base, hints };
  doc.date = isValidIsoDate(ai.datum) ? ai.datum : today;

  const cur = normalizeCurrency(ai.waehrung);
  doc.currency = cur || settings.currency || 'EUR';
  if (!cur && ai.waehrung) hints.push({ code: 'currencyUnknown', params: { value: String(ai.waehrung) } });

  doc.customer = {
    name: (ai.kunde?.name || '').trim(),
    address: (ai.kunde?.adresse || '').trim(),
    ice: '',
  };
  if (!doc.customer.name) hints.push({ code: 'customerMissing' });

  doc.lines = ai.positionen.map((p, i) => {
    const hasRate = isNum(p.mwstSatz);
    let taxRate = hasRate ? numberToInput(p.mwstSatz, 2) : '';
    if (!hasRate && settings.defaultTaxRate !== '' && settings.defaultTaxRate !== undefined) {
      taxRate = String(settings.defaultTaxRate);
      hints.push({ code: 'defaultTaxApplied', params: { line: i + 1, rate: taxRate } });
    }
    const line = {
      id: newId('l'),
      name: p.artikelName.trim(),
      qty: isNum(p.menge) ? numberToInput(p.menge, 3) : '1',
      unit: p.einheit ? p.einheit.trim() : '',
      price: isNum(p.einzelpreisNetto) ? numberToInput(p.einzelpreisNetto, 4) : '',
      discountType: 'amount',
      discount: isNum(p.rabattNetto) && p.rabattNetto !== 0 ? numberToInput(p.rabattNetto, 2) : '',
      taxRate,
    };
    if (line.price === '') hints.push({ code: 'priceMissing', params: { line: i + 1 } });
    if (taxRate === '') hints.push({ code: 'taxMissing', params: { line: i + 1 } });
    return line;
  });
  // Rabatt-Spalte nur einschalten, wenn die KI tatsächlich einen Rabatt gefunden hat
  doc.showDiscount = doc.lines.some((l) => l.discount !== '');
  if (doc.lines.length === 0) {
    doc.lines = [emptyLine(settings)];
    hints.push({ code: 'noLinesFound' });
  }

  // Zahlungsbedingungen und Datum je nach Dokumententyp
  if (type === 'invoice') {
    doc.validUntil = '';
    doc.paymentTerms = ai.zahlungsbedingungen || `${Number(settings.defaultPaymentDays) || 14} Tage nach Rechnungsdatum`;
    if (isValidIsoDate(ai.faelligkeitsDatum)) {
      doc.dueDate = ai.faelligkeitsDatum;
    } else {
      const terms = parsePaymentDays(doc.paymentTerms);
      if (terms && !terms.fromReceipt) {
        doc.dueDate = addDays(doc.date, terms.days);
      } else {
        doc.dueDate = '';
        hints.push({ code: terms?.fromReceipt ? 'dueFromReceipt' : 'dueUnknown' });
      }
    }
  } else {
    doc.dueDate = '';
    doc.paymentTerms = ai.zahlungsbedingungen || '';
    if (isValidIsoDate(ai.gueltigBis)) {
      doc.validUntil = ai.gueltigBis;
    } else {
      doc.validUntil = addDays(doc.date, Number(settings.quoteValidDays) || 30);
      hints.push({ code: 'defaultValidityApplied', params: { days: Number(settings.quoteValidDays) || 30 } });
    }
  }

  // Originalhinweise der KI übernehmen
  for (const text of ai.hinweise || []) hints.push({ code: 'ai', text });
  if (ai.vollstaendig === false && !(ai.hinweise || []).length) hints.push({ code: 'aiIncomplete' });

  // Summen der KI mit eigener Berechnung vergleichen
  const own = documentTotals(doc.lines);
  const cmp = compareAiTotals(ai, own);
  if (cmp.length) hints.push({ code: 'aiTotalsMismatch', params: { fields: cmp.join(', ') } });

  doc.hints = dedupeHints(hints);
  doc.reviewed = false;
  return doc;
}

function dedupeHints(hints) {
  const seen = new Set();
  return hints.filter((h) => {
    const key = `${h.code}|${h.text || ''}|${JSON.stringify(h.params || {})}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Liefert die Namen der Summenfelder, bei denen KI und eigene Berechnung um mehr als 1 Cent abweichen. */
export function compareAiTotals(ai, own) {
  const diffs = [];
  const check = (name, aiValue, ownValue) => {
    if (!isNum(aiValue) || ownValue === null) return;
    const aiCents = parseDecimal(aiValue, 2);
    if (aiCents === null) return;
    const delta = aiCents - ownValue;
    if ((delta < 0n ? -delta : delta) > 1n) diffs.push(name);
  };
  check('gesamtNetto', ai.gesamtNetto, own.net);
  check('steuerBetrag', ai.steuerBetrag, own.tax);
  check('gesamtBrutto', ai.gesamtBrutto, own.gross);
  return diffs;
}

// ---------- Prüfregeln für Dokumente ----------

/**
 * Prüft ein Dokument. Rückgabe: Liste { level: 'error' | 'warning', code, params }.
 * Fehler verhindern das Fertigstellen; Entwürfe lassen sich immer speichern.
 */
export function checkDocument(doc) {
  const issues = [];
  const err = (code, params) => issues.push({ level: 'error', code, params });
  const warn = (code, params) => issues.push({ level: 'warning', code, params });

  if (!doc.customer?.name?.trim()) err('customerMissing');
  if (!isValidIsoDate(doc.date)) err('dateInvalid');
  if (!doc.currency) err('currencyMissing');

  if (doc.type === 'invoice') {
    if (!isValidIsoDate(doc.dueDate)) err('dueMissing');
    else if (isValidIsoDate(doc.date) && doc.dueDate < doc.date) err('dueBeforeDate');
    if (!doc.paymentTerms?.trim()) warn('termsMissing');
  } else if (doc.type === 'quote') {
    if (!isValidIsoDate(doc.validUntil)) warn('validUntilMissing');
    else if (isValidIsoDate(doc.date) && doc.validUntil < doc.date) err('validBeforeDate');
  }

  if (!doc.lines || doc.lines.length === 0) err('noLines');
  (doc.lines || []).forEach((line, idx) => {
    const n = idx + 1;
    if (!line.name?.trim()) err('lineNameMissing', { line: n });

    const qty = parseDecimal(line.qty, QTY_SCALE);
    if (qty === null || qty <= 0n) err('lineQtyInvalid', { line: n });

    const price = parseDecimal(line.price, PRICE_SCALE);
    if (price === null) err('linePriceMissing', { line: n });
    else if (price < 0n) err('linePriceNegative', { line: n });

    const rate = parseDecimal(line.taxRate, PCT_SCALE);
    if (rate === null) err('lineTaxMissing', { line: n });
    else if (rate < 0n || rate > 10000n) err('lineTaxRange', { line: n });

    const hasDiscount = String(line.discount ?? '').trim() !== '';
    if (hasDiscount) {
      const d = parseDecimal(line.discount, PCT_SCALE);
      if (d === null || d < 0n) err('lineDiscountInvalid', { line: n });
      else {
        const a = lineAmounts(line);
        if (line.discountType === 'percent' && d > 10000n) err('lineDiscountInvalid', { line: n });
        else if (a.net !== null && a.net < 0n) err('lineDiscountTooHigh', { line: n });
      }
    }
  });

  const unresolved = (doc.hints || []).length > 0 && !doc.reviewed;
  if (unresolved) err('hintsNotReviewed');

  return issues;
}

export function hasErrors(issues) {
  return issues.some((i) => i.level === 'error');
}

/** Nummernformat: PREFIX-JAHR-0001 */
export function formatNumber(prefix, year, counter) {
  return `${prefix}-${year}-${String(counter).padStart(4, '0')}`;
}
