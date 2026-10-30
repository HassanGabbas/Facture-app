import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDecimal, roundDiv, lineAmounts, documentTotals, formatCents, formatMoney, formatPercent, centsToInput, numberToInput,
} from '../js/calc.js';

test('parseDecimal: Formate und Randfälle', () => {
  assert.equal(parseDecimal('12,5', 2), 1250n);
  assert.equal(parseDecimal('1.234,50', 2), 123450n);
  assert.equal(parseDecimal('1,234.50', 2), 123450n);
  assert.equal(parseDecimal('111', 4), 1110000n);
  assert.equal(parseDecimal('', 2), null);
  assert.equal(parseDecimal('abc', 2), null);
  assert.equal(parseDecimal(null, 2), null);
  assert.equal(parseDecimal(0.1 + 0.2, 2), 30n);
  assert.equal(parseDecimal('-5,5', 2), -550n);
  assert.equal(parseDecimal('2.005', 2), 201n); // halb auf
});

test('roundDiv rundet kaufmännisch', () => {
  assert.equal(roundDiv(5n, 10n), 1n);
  assert.equal(roundDiv(4n, 10n), 0n);
  assert.equal(roundDiv(-5n, 10n), -1n);
  assert.equal(roundDiv(14n, 10n), 1n);
  assert.equal(roundDiv(15n, 10n), 2n);
});

test('Beispiel Kunstrasen: 120 m² à 111 + Transport 500, 20 % TVA', () => {
  const lines = [
    { qty: '120', price: '111', taxRate: '20' },
    { qty: '1', price: '500', taxRate: '20' },
  ];
  const t = documentTotals(lines);
  assert.equal(t.net, 1382000n); // 13.320 + 500 = 13.820,00
  assert.equal(t.tax, 276400n);
  assert.equal(t.gross, 1658400n);
  assert.equal(formatMoney(t.gross, 'MAD', 'fr'), '16 584,00 MAD');
});

test('Beispiel aus dem Prompt: 2 Stück à 150, 19 %', () => {
  const a = lineAmounts({ qty: '2', price: '150', taxRate: '19' });
  assert.deepEqual([a.net, a.tax, a.gross], [30000n, 5700n, 35700n]);
});

test('Gleitkomma-Fallen: 0,1 + 0,2 und 1,005 × 3', () => {
  const t = documentTotals([
    { qty: '1', price: '0.1', taxRate: '0' },
    { qty: '1', price: '0.2', taxRate: '0' },
  ]);
  assert.equal(t.net, 30n);
  const a = lineAmounts({ qty: '3', price: '1.005', taxRate: '0' });
  assert.equal(a.net, 302n); // 3,015 -> 3,02
});

test('Steuer wird je Position gerundet und dann addiert', () => {
  const lines = Array.from({ length: 3 }, () => ({ qty: '1', price: '0.10', taxRate: '19' }));
  const t = documentTotals(lines);
  assert.equal(t.tax, 6n); // 3 × round(1,9 Cent = 2) = 6, nicht round(5,7) = 6 -> hier gleich; Einzelprüfung unten
  const one = lineAmounts(lines[0]);
  assert.equal(one.tax, 2n);
  const lines2 = Array.from({ length: 10 }, () => ({ qty: '1', price: '0.10', taxRate: '19' }));
  assert.equal(documentTotals(lines2).tax, 20n); // 10 × 2 Cent, Summe der Rundungen
});

test('Rabatt als Betrag und Prozent', () => {
  const amount = lineAmounts({ qty: '10', price: '20', discountType: 'amount', discount: '25', taxRate: '20' });
  assert.equal(amount.net, 17500n);
  assert.equal(amount.tax, 3500n);
  const pct = lineAmounts({ qty: '10', price: '20', discountType: 'percent', discount: '10', taxRate: '20' });
  assert.equal(pct.net, 18000n);
});

test('Unvollständige Daten ergeben null-Summen statt falscher Werte', () => {
  const t = documentTotals([
    { qty: '2', price: '10', taxRate: '20' },
    { qty: '1', price: '', taxRate: '20' },
  ]);
  assert.equal(t.net, null);
  assert.equal(t.gross, null);
  const noTax = documentTotals([{ qty: '2', price: '10', taxRate: '' }]);
  assert.equal(noTax.net, 2000n);
  assert.equal(noTax.tax, null);
  assert.equal(noTax.gross, null);
});

test('Steueraufschlüsselung nach Satz', () => {
  const t = documentTotals([
    { qty: '1', price: '100', taxRate: '20' },
    { qty: '1', price: '50', taxRate: '10' },
    { qty: '2', price: '25', taxRate: '20' },
  ]);
  assert.equal(t.byRate.length, 2);
  assert.equal(t.byRate[0].rate, 1000n);
  assert.equal(t.byRate[1].net, 15000n);
  assert.equal(t.byRate[1].tax, 3000n);
});

test('Formatierung', () => {
  assert.equal(formatCents(123456n, 'de'), '1.234,56');
  assert.equal(formatCents(-5n, 'de'), '-0,05');
  assert.equal(formatCents(100000000n, 'en'), '1,000,000.00');
  assert.equal(formatPercent(2000n), '20');
  assert.equal(formatPercent(550n), '5,5');
  assert.equal(centsToInput(123450n), '1234.50');
  assert.equal(numberToInput(150), '150');
  assert.equal(numberToInput(0.1 + 0.2), '0.3');
  assert.equal(numberToInput(null), '');
});
