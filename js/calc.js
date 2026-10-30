// Geldberechnung ohne Gleitkomma: alle Werte sind BigInt-Festkommazahlen.
//   Menge:      Skalierung 3  (1,5 -> 1500n)
//   Preis:      Skalierung 4  (111,00 -> 1110000n)
//   Prozent:    Skalierung 2  (20 % -> 2000n)
//   Geldbetrag: Cent (Skalierung 2)
// Gerundet wird kaufmännisch (halb weg von null).

export const QTY_SCALE = 3;
export const PRICE_SCALE = 4;
export const PCT_SCALE = 2;

const pow10 = (n) => 10n ** BigInt(n);

/** Teilt n durch d (d > 0) und rundet kaufmännisch (0,5 wird von null weg gerundet). */
export function roundDiv(n, d) {
  const neg = n < 0n;
  const a = neg ? -n : n;
  let q = a / d;
  if ((a % d) * 2n >= d) q += 1n;
  return neg ? -q : q;
}

/**
 * Wandelt Text oder Zahl in eine skalierte BigInt-Zahl um.
 * Akzeptiert "12,5", "1.234,50", "1,234.50", "12.5". Leer oder ungültig -> null.
 */
export function parseDecimal(input, scale) {
  if (input === null || input === undefined) return null;
  let s;
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return null;
    s = String(input);
    if (/e/i.test(s)) s = input.toFixed(scale + 2);
  } else if (typeof input === 'bigint') {
    return input * pow10(scale);
  } else {
    s = String(input);
  }
  s = s.trim().replace(/[\s  ']/g, '');
  if (s === '') return null;

  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma !== -1 && lastDot !== -1) {
    // Das zuletzt vorkommende Zeichen ist das Dezimaltrennzeichen.
    s = lastComma > lastDot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (lastComma !== -1) {
    if (s.indexOf(',') !== lastComma) s = s.replace(/,/g, '');
    else s = s.replace(',', '.');
  }

  const m = /^([+-])?(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m) return null;
  const intPart = m[2] || '';
  const frac = m[3] || '';
  if (intPart === '' && frac === '') return null;

  const kept = frac.slice(0, scale).padEnd(scale, '0');
  let value = BigInt((intPart || '0') + kept);
  if (frac.length > scale && frac[scale] >= '5') value += 1n; // halb auf (Betrag)
  return m[1] === '-' ? -value : value;
}

/** Netto-, Steuer- und Bruttobetrag einer Position (Cent). Unvollständige Eingaben -> null-Felder. */
export function lineAmounts(line) {
  const qty = parseDecimal(line.qty, QTY_SCALE);
  const price = parseDecimal(line.price, PRICE_SCALE);
  const empty = { base: null, discount: null, net: null, tax: null, gross: null };
  if (qty === null || price === null) return empty;

  const base = roundDiv(qty * price, pow10(QTY_SCALE + PRICE_SCALE - 2));

  let discount = 0n;
  const rawDiscount = line.discount;
  const hasDiscount = rawDiscount !== undefined && rawDiscount !== null && String(rawDiscount).trim() !== '';
  if (hasDiscount) {
    const d = parseDecimal(rawDiscount, PCT_SCALE);
    if (d === null) return empty;
    discount = line.discountType === 'percent' ? roundDiv(base * d, pow10(PCT_SCALE + 2)) : d;
  }

  const net = base - discount;
  const rate = parseDecimal(line.taxRate, PCT_SCALE);
  if (rate === null) return { base, discount, net, tax: null, gross: null };

  const tax = roundDiv(net * rate, pow10(PCT_SCALE + 2));
  return { base, discount, net, tax, gross: net + tax };
}

/**
 * Summen eines Dokuments. Die Steuer wird je Position gerundet und dann addiert.
 * Fehlt bei einer Position ein Wert, bleibt die betroffene Summe null.
 */
export function documentTotals(lines) {
  let net = 0n;
  let tax = 0n;
  let netComplete = true;
  let taxComplete = true;
  const byRate = new Map();

  for (const line of lines) {
    const a = lineAmounts(line);
    if (a.net === null) {
      netComplete = false;
      taxComplete = false;
      continue;
    }
    net += a.net;
    if (a.tax === null) {
      taxComplete = false;
      continue;
    }
    tax += a.tax;
    const key = String(parseDecimal(line.taxRate, PCT_SCALE));
    const entry = byRate.get(key) || { rate: parseDecimal(line.taxRate, PCT_SCALE), net: 0n, tax: 0n };
    entry.net += a.net;
    entry.tax += a.tax;
    byRate.set(key, entry);
  }

  const netTotal = netComplete ? net : null;
  const taxTotal = taxComplete ? tax : null;
  return {
    net: netTotal,
    tax: taxTotal,
    gross: netTotal !== null && taxTotal !== null ? netTotal + taxTotal : null,
    byRate: taxComplete ? [...byRate.values()].sort((a, b) => (a.rate < b.rate ? -1 : 1)) : [],
  };
}

const SEPARATORS = {
  de: { group: '.', decimal: ',' },
  fr: { group: ' ', decimal: ',' },
  en: { group: ',', decimal: '.' },
};

/** Formatiert Cent als Text, z. B. 123456n -> "1.234,56" (de) oder "1 234,56" (fr). */
export function formatCents(cents, lang = 'de') {
  if (cents === null || cents === undefined) return '–';
  const sep = SEPARATORS[lang] || SEPARATORS.de;
  const neg = cents < 0n;
  const abs = neg ? -cents : cents;
  const whole = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, sep.group);
  const frac = (abs % 100n).toString().padStart(2, '0');
  return `${neg ? '-' : ''}${whole}${sep.decimal}${frac}`;
}

export function formatMoney(cents, currency, lang = 'de') {
  if (cents === null || cents === undefined) return '–';
  const label = { EUR: '€', MAD: 'MAD', USD: '$' }[currency] || currency || '';
  return `${formatCents(cents, lang)} ${label}`.trim();
}

/**
 * Formatiert eine skalierte Zahl. Nachkommastellen werden bis minDecimals gekürzt, wenn sie 0 sind.
 * z. B. formatScaled(1110000n, 4, 2) -> "1.110,00"; formatScaled(120000n, 3, 0) -> "120"
 */
export function formatScaled(value, scale, minDecimals = 0, lang = 'de') {
  if (value === null || value === undefined) return '–';
  const sep = SEPARATORS[lang] || SEPARATORS.de;
  const neg = value < 0n;
  const abs = neg ? -value : value;
  const p = pow10(scale);
  const whole = (abs / p).toString().replace(/\B(?=(\d{3})+(?!\d))/g, sep.group);
  let frac = (abs % p).toString().padStart(scale, '0');
  while (frac.length > minDecimals && frac.endsWith('0')) frac = frac.slice(0, -1);
  return `${neg ? '-' : ''}${whole}${frac ? sep.decimal + frac : ''}`;
}

/** Prozent-Skalierung 2 als Text, z. B. 2000n -> "20", 550n -> "5,5". */
export function formatPercent(scaled, lang = 'de') {
  if (scaled === null || scaled === undefined) return '–';
  const sep = (SEPARATORS[lang] || SEPARATORS.de).decimal;
  const whole = scaled / 100n;
  const frac = (scaled % 100n).toString().padStart(2, '0').replace(/0+$/, '');
  return frac ? `${whole}${sep}${frac}` : `${whole}`;
}

/** Cent als Eingabetext mit Punkt, z. B. 123450n -> "1234.50". */
export function centsToInput(cents) {
  if (cents === null || cents === undefined) return '';
  const neg = cents < 0n;
  const abs = neg ? -cents : cents;
  return `${neg ? '-' : ''}${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}`;
}

/** Zahl aus der KI (JS-Number) in einen sauberen Eingabetext mit höchstens 4 Nachkommastellen. */
export function numberToInput(value, maxDecimals = 4) {
  if (value === null || value === undefined || value === '') return '';
  const n = typeof value === 'number' ? value : Number(String(value).replace(',', '.'));
  if (!Number.isFinite(n)) return '';
  return String(Number(n.toFixed(maxDecimals)));
}
