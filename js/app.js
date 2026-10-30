// Oberfläche der Rechnungs- und Angebots-App.
import { Store } from './store.js';
import { t, setLang, getLang, formatDate, LANGUAGES } from './i18n.js';
import {
  parseDecimal, lineAmounts, documentTotals, formatMoney, formatScaled, PCT_SCALE, QTY_SCALE, PRICE_SCALE,
} from './calc.js';
import {
  newDocument, emptyLine, draftFromAi, checkDocument, hasErrors, todayIso, addDays, parsePaymentDays,
  isValidIsoDate, newId,
} from './model.js';
import { createProvider, isAiConfigured, extractDocumentData, AiError, MAX_TEXT_LENGTH } from './ai.js';

const store = new Store(window.localStorage);
let settings = store.getSettings();
setLang(settings.lang);

const state = {
  draft: null, // Dokument im Editor (bleibt im Speicher, bis es gespeichert oder verlassen wird)
  dirty: false,
  showIssues: false,
  aiText: '',
  aiBusy: false,
  aiStatus: null, // { key, kind, extra }
  filter: 'all',
  search: '',
  lastRoute: '',
  logoDraft: undefined, // ungespeichertes Logo in den Einstellungen (undefined = unverändert, '' = entfernt)
};

const $ = (sel, el = document) => el.querySelector(sel);
const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const main = () => $('#main');

// ---------- Kleinigkeiten ----------

let toastTimer;
function toast(message, kind = 'info') {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 4500);
}

function money(cents, currency) {
  return formatMoney(cents, currency, getLang());
}

function typeLabel(type) {
  return type === 'invoice' ? t('invoice') : t('quote');
}

function setPath(obj, path, value) {
  const parts = path.split('.');
  let o = obj;
  for (let i = 0; i < parts.length - 1; i += 1) o = o[parts[i]];
  o[parts[parts.length - 1]] = value;
}

function hasContent(d) {
  return Boolean(
    d && (d.customer.name.trim() || d.lines.some((l) => l.name.trim() || String(l.price).trim())),
  );
}

function autoDue(d) {
  if (d.type !== 'invoice' || !isValidIsoDate(d.date)) return null;
  const terms = parsePaymentDays(d.paymentTerms);
  return terms && !terms.fromReceipt ? addDays(d.date, terms.days) : null;
}

function persist(doc) {
  try {
    const saved = store.saveDocument(doc);
    if (doc.customer?.name) store.upsertCustomer(doc.customer);
    return saved;
  } catch {
    toast(t('storageFull'), 'error');
    return null;
  }
}

/** Beim Verlassen des Editors wird ein veränderter Entwurf automatisch gesichert. */
function autosaveIfNeeded() {
  const d = state.draft;
  if (!d || !state.dirty || !hasContent(d)) return;
  const saved = persist({ ...d, status: 'draft' });
  if (saved) {
    state.draft = saved;
    state.dirty = false;
    toast(t('autosaved'), 'info');
  }
}

// ---------- Routing ----------

function parseRoute() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [name = '', arg = ''] = raw.split('/');
  return { name, arg, raw };
}

function go(hash, replace = false) {
  if (replace) history.replaceState(null, '', hash);
  else location.hash = hash;
  if (replace) render();
}

function render() {
  const r = parseRoute();
  const leavingEditor = state.lastRoute.startsWith('edit/') && state.lastRoute !== r.raw;
  if (leavingEditor) autosaveIfNeeded();
  state.lastRoute = r.raw;
  if (r.name !== 'settings') state.logoDraft = undefined;

  document.documentElement.lang = getLang();
  renderChrome(r.name);

  const el = main();
  switch (r.name) {
    case '':
      el.innerHTML = viewHome();
      break;
    case 'new':
      if (r.arg === 'invoice' || r.arg === 'quote') {
        state.draft = newDocument(r.arg, settings, todayIso());
        state.dirty = false;
        state.showIssues = false;
        state.aiText = '';
        state.aiStatus = null;
        history.replaceState(null, '', `#/edit/${state.draft.id}`);
        state.lastRoute = `edit/${state.draft.id}`;
        el.innerHTML = viewEditor();
        refreshLive();
      } else {
        el.innerHTML = viewNewChooser();
      }
      break;
    case 'edit': {
      const doc = state.draft?.id === r.arg ? state.draft : store.getDocument(r.arg);
      if (!doc) {
        el.innerHTML = viewNotFound();
        break;
      }
      if (state.draft?.id !== doc.id) {
        state.draft = doc;
        state.dirty = false;
        state.showIssues = false;
        state.aiStatus = null;
      }
      el.innerHTML = viewEditor();
      refreshLive();
      break;
    }
    case 'preview': {
      const doc = state.draft?.id === r.arg ? state.draft : store.getDocument(r.arg);
      el.innerHTML = doc ? viewPreview(doc) : viewNotFound();
      break;
    }
    case 'docs':
      el.innerHTML = viewDocs();
      break;
    case 'settings':
      el.innerHTML = viewSettings();
      break;
    default:
      el.innerHTML = viewNotFound();
  }
  window.scrollTo(0, 0);
}

function renderChrome(active) {
  const items = [
    ['', 'navHome', '⌂'],
    ['new', 'navNew', '＋'],
    ['docs', 'navDocs', '☰'],
    ['settings', 'navSettings', '⚙'],
  ];
  $('#nav').innerHTML = items
    .map(
      ([name, label, icon]) =>
        `<a href="#/${name}" class="${active === name ? 'active' : ''}" aria-label="${esc(t(label))}"><span class="ico" aria-hidden="true">${icon}</span><span>${esc(t(label))}</span></a>`,
    )
    .join('');
  $('#appTitle').textContent = t('appName');
  updateOnline();
}

function updateOnline() {
  const el = $('#online');
  if (!el) return;
  const on = navigator.onLine !== false;
  el.textContent = on ? t('online') : t('offline');
  el.className = `badge ${on ? 'ok' : 'warn'}`;
}

// ---------- Ansichten ----------

function viewNotFound() {
  return `<section class="card"><p>${esc(t('notFound'))}</p><a class="btn" href="#/docs">${esc(t('navDocs'))}</a></section>`;
}

function viewNewChooser() {
  return `
    <section class="stack">
      <h1>${esc(t('navNew'))}</h1>
      <a class="btn big primary" href="#/new/invoice">${esc(t('newInvoice'))}</a>
      <a class="btn big" href="#/new/quote">${esc(t('newQuote'))}</a>
    </section>`;
}

function docBody(d) {
  const totals = documentTotals(d.lines);
  const title = d.number || t('statusDraft');
  return `
      <a class="doc-main" href="#/edit/${esc(d.id)}">
        <div class="doc-top"><strong>${esc(title)}</strong>
          <span class="badge ${d.status === 'final' ? 'ok' : 'warn'}">${esc(d.status === 'final' ? t('statusFinal') : t('statusDraft'))}</span></div>
        <div class="doc-mid">${esc(typeLabel(d.type))} · ${esc(d.customer.name || '–')}</div>
        <div class="doc-bot"><span>${esc(formatDate(d.date))}</span><strong>${esc(money(totals.gross, d.currency))}</strong></div>
      </a>`;
}

function docRow(d) {
  return `<li class="doc">${docBody(d)}</li>`;
}

function viewHome() {
  const docs = store.listDocuments();
  const count = (type) => docs.filter((d) => d.type === type && d.status === 'final').length;
  const drafts = docs.filter((d) => d.status !== 'final').length;
  const needsSetup = !settings.company.name.trim() || settings.defaultTaxRate === '';
  return `
    <section class="stack">
      <h1>${esc(t('dashboard'))}</h1>
      ${needsSetup ? `<div class="notice warn"><p>${esc(t('setupCompany'))}</p><a class="btn small" href="#/settings">${esc(t('toSettings'))}</a></div>` : ''}
      <div class="actions two">
        <a class="btn primary big" href="#/new/invoice">${esc(t('newInvoice'))}</a>
        <a class="btn big" href="#/new/quote">${esc(t('newQuote'))}</a>
      </div>
      <div class="tiles">
        <div class="tile"><span class="num">${count('invoice')}</span><span>${esc(t('invoices'))}</span></div>
        <div class="tile"><span class="num">${count('quote')}</span><span>${esc(t('quotes'))}</span></div>
        <div class="tile"><span class="num">${drafts}</span><span>${esc(t('draftsCount'))}</span></div>
      </div>
      <h2>${esc(t('recent'))}</h2>
      ${docs.length ? `<ul class="docs">${docs.slice(0, 5).map(docRow).join('')}</ul>` : `<p class="muted">${esc(t('noDocs'))}</p>`}
      <p class="muted small">${esc(t('installHint'))}</p>
    </section>`;
}

// ----- Editor -----

function field(label, inner, cls = '') {
  return `<label class="field ${cls}"><span>${esc(label)}</span>${inner}</label>`;
}

function input(f, value, extra = '') {
  return `<input data-f="${esc(f)}" value="${esc(value)}" ${extra}>`;
}

function lineHtml(line, i, invalid, showDiscount) {
  const L = (f, v, extra = '') => `<input data-line="${i}" data-f="${f}" value="${esc(v)}" ${extra}>`;
  return `
    <div class="line ${invalid ? 'invalid' : ''}" data-i="${i}">
      <div class="line-head"><strong>${esc(t('position'))} ${i + 1}</strong>
        <button type="button" class="link danger" data-action="remove-line" data-i="${i}">${esc(t('removeLine'))}</button></div>
      ${field(t('lineName'), L('name', line.name, 'autocomplete="off"'))}
      <div class="grid3">
        ${field(t('qty'), L('qty', line.qty, 'inputmode="decimal"'))}
        ${field(t('unit'), L('unit', line.unit, 'autocomplete="off"'))}
        ${field(t('price'), L('price', line.price, 'inputmode="decimal"'))}
      </div>
      ${showDiscount
        ? `<div class="grid3">
        ${field(t('discount'), L('discount', line.discount, 'inputmode="decimal"'))}
        ${field('', `<select data-line="${i}" data-f="discountType" aria-label="${esc(t('discount'))}">
            <option value="amount" ${line.discountType !== 'percent' ? 'selected' : ''}>${esc(t('discountAmount'))}</option>
            <option value="percent" ${line.discountType === 'percent' ? 'selected' : ''}>${esc(t('discountPercent'))}</option></select>`, 'nolabel')}
        ${field(t('taxRate'), L('taxRate', line.taxRate, 'inputmode="decimal"'))}
      </div>`
        : `<div class="grid3">${field(t('taxRate'), L('taxRate', line.taxRate, 'inputmode="decimal"'))}</div>`}
      <div class="line-net">${esc(t('lineNet'))}: <strong data-line-net="${i}"></strong></div>
    </div>`;
}

function hintsHtml(d) {
  if (!d.hints.length) return '';
  const items = d.hints.map((h) => `<li>${esc(t(`hint_${h.code}`, { ...(h.params || {}), text: h.text }))}</li>`).join('');
  return `
    <div class="notice warn" id="hints">
      <strong>${esc(t('hintsTitle'))}</strong>
      <ul>${items}</ul>
      <label class="check"><input type="checkbox" data-reviewed ${d.reviewed ? 'checked' : ''}> ${esc(t('reviewHints'))}</label>
    </div>`;
}

function issuesHtml(d) {
  if (!state.showIssues) return '';
  const issues = checkDocument(d);
  if (!issues.length) return '';
  return `<div class="notice ${hasErrors(issues) ? 'error' : 'warn'}"><strong>${esc(t('sectionIssues'))}</strong><ul>${issues
    .map((i) => `<li>${esc(t(`issue_${i.code}`, i.params || {}))}</li>`)
    .join('')}</ul></div>`;
}

function totalsRows(d) {
  const totals = documentTotals(d.lines);
  const L = getLang();
  const rows = [[t('net'), money(totals.net, d.currency)]];
  for (const r of totals.byRate) {
    rows.push([t('taxOn', { rate: formatScaled(r.rate, PCT_SCALE, 0, L), base: money(r.net, d.currency) }), money(r.tax, d.currency)]);
  }
  if (!totals.byRate.length) rows.push([t('tax'), money(totals.tax, d.currency)]);
  rows.push([t('gross'), money(totals.gross, d.currency), true]);
  return rows;
}

function totalsHtml(d) {
  return totalsRows(d)
    .map(([label, value, strong]) => `<div class="sum-row ${strong ? 'strong' : ''}"><span>${esc(label)}</span><span>${esc(value)}</span></div>`)
    .join('');
}

function currencyOptions(current) {
  const list = ['EUR', 'MAD', 'USD'];
  if (current && !list.includes(current)) list.push(current);
  return list.map((c) => `<option value="${esc(c)}" ${c === current ? 'selected' : ''}>${esc(c)}</option>`).join('');
}

function aiStatusHtml() {
  const s = state.aiStatus;
  if (state.aiBusy) return `<p class="muted" id="aiStatus">${esc(t('aiRunning'))}</p>`;
  if (!s) return '<p id="aiStatus"></p>';
  return `<p id="aiStatus" class="msg ${s.kind}">${esc(t(s.key))}${s.extra ? ` <span class="small">${esc(s.extra)}</span>` : ''}</p>`;
}

function viewEditor() {
  const d = state.draft;
  const isInvoice = d.type === 'invoice';
  const issues = state.showIssues ? checkDocument(d) : [];
  const badLines = new Set(issues.filter((i) => i.level === 'error' && i.params?.line).map((i) => i.params.line - 1));
  const customers = store.listCustomers();
  return `
    <section class="stack">
      <h1>${esc(typeLabel(d.type))} <span class="badge ${d.status === 'final' ? 'ok' : 'warn'}">${esc(d.status === 'final' ? t('statusFinal') : t('statusDraft'))}</span></h1>
      <p class="muted small">${esc(t('number'))}: ${esc(d.number || t('numberAuto'))}</p>

      <div class="card">
        <h2>${esc(t('aiTitle'))}</h2>
        <p class="muted small">${esc(t('aiHelp'))}</p>
        <textarea id="aiText" rows="5" maxlength="${MAX_TEXT_LENGTH}" placeholder="${esc(t('aiPlaceholder'))}">${esc(state.aiText)}</textarea>
        <div class="actions"><button type="button" class="btn primary" id="aiRun" data-action="ai-run" ${state.aiBusy ? 'disabled' : ''}>${esc(t('aiRun'))}</button></div>
        <p class="muted small">${esc(t('aiNeedsInternet'))}</p>
        ${aiStatusHtml()}
      </div>

      ${hintsHtml(d)}

      <div class="card">
        <h2>${esc(t('sectionCustomer'))}</h2>
        ${field(t('customerName'), input('customer.name', d.customer.name, 'list="customerList" autocomplete="off"'))}
        <datalist id="customerList">${customers.map((c) => `<option value="${esc(c.name)}"></option>`).join('')}</datalist>
        ${field(t('customerAddress'), `<textarea data-f="customer.address" rows="2">${esc(d.customer.address)}</textarea>`)}
        ${field(t('customerIce'), input('customer.ice', d.customer.ice || '', 'autocomplete="off" inputmode="numeric"'))}
      </div>

      <div class="card">
        <h2>${esc(t('sectionDates'))}</h2>
        <div class="grid2">
          ${field(t('date'), input('date', d.date, 'type="date"'))}
          ${isInvoice ? field(t('dueDate'), input('dueDate', d.dueDate, 'type="date"')) : field(t('validUntil'), input('validUntil', d.validUntil, 'type="date"'))}
        </div>
        ${isInvoice ? field(t('paymentTerms'), input('paymentTerms', d.paymentTerms)) : ''}
        ${field(t('currency'), `<select data-f="currency">${currencyOptions(d.currency)}</select>`)}
      </div>

      <div class="card">
        <h2>${esc(t('docSettings'))}</h2>
        <label class="check"><input type="checkbox" data-toggle-discount ${d.showDiscount ? 'checked' : ''}> ${esc(t('showDiscount'))}</label>
      </div>

      <div class="card">
        ${field(t('extraInfo'), `<textarea data-f="extraInfo" rows="3">${esc(d.extraInfo || '')}</textarea>`)}
        <p class="muted small">${esc(t('extraInfoHelp'))}</p>
      </div>

      <div class="card">
        <h2>${esc(t('sectionLines'))}</h2>
        <div id="lines">${d.lines.map((l, i) => lineHtml(l, i, badLines.has(i), d.showDiscount)).join('')}</div>
        <button type="button" class="btn" data-action="add-line">＋ ${esc(t('addLine'))}</button>
      </div>

      <div class="card">
        ${field(t('notes'), `<textarea data-f="notes" rows="3">${esc(d.notes)}</textarea>`)}
      </div>

      <div class="card sums"><h2>${esc(t('totals'))}</h2><div id="totals">${totalsHtml(d)}</div></div>

      <div id="issues">${issuesHtml(d)}</div>

      <div class="actions sticky">
        <button type="button" class="btn" data-action="save-draft">${esc(t('saveDraft'))}</button>
        <button type="button" class="btn" data-action="preview">${esc(t('preview'))}</button>
        <button type="button" class="btn primary" data-action="finalize">${esc(t('finalize'))}</button>
      </div>
    </section>`;
}

/** Aktualisiert Summen, Zeilensummen und Prüfmeldungen, ohne die Eingabefelder neu aufzubauen. */
function refreshLive() {
  const d = state.draft;
  if (!d || !$('#totals')) return;
  $('#totals').innerHTML = totalsHtml(d);
  d.lines.forEach((line, i) => {
    const el = $(`[data-line-net="${i}"]`);
    if (el) el.textContent = money(lineAmounts(line).net, d.currency);
  });
  $('#issues').innerHTML = issuesHtml(d);
  if (state.showIssues) {
    const issues = checkDocument(d);
    const bad = new Set(issues.filter((x) => x.level === 'error' && x.params?.line).map((x) => x.params.line - 1));
    document.querySelectorAll('.line').forEach((el) => el.classList.toggle('invalid', bad.has(Number(el.dataset.i))));
  }
}

// ----- Vorschau -----

function sheetHtml(d) {
  const L = getLang();
  const c = settings.company;
  const isInvoice = d.type === 'invoice';
  const rows = d.lines
    .map((line, i) => {
      const a = lineAmounts(line);
      const qty = formatScaled(parseDecimal(line.qty, QTY_SCALE), QTY_SCALE, 0, L);
      const price = formatScaled(parseDecimal(line.price, PRICE_SCALE), PRICE_SCALE, 2, L);
      const disc = !d.showDiscount || String(line.discount).trim() === ''
        ? ''
        : line.discountType === 'percent'
          ? `${formatScaled(parseDecimal(line.discount, PCT_SCALE), PCT_SCALE, 0, L)} %`
          : money(parseDecimal(line.discount, PCT_SCALE), d.currency);
      const rate = line.taxRate === '' ? '–' : `${formatScaled(parseDecimal(line.taxRate, PCT_SCALE), PCT_SCALE, 0, L)} %`;
      return `<tr>
        <td>${i + 1}</td>
        <td>${esc(line.name)}</td>
        <td class="r">${esc(qty)} ${esc(line.unit)}</td>
        <td class="r">${esc(price)}</td>
        ${d.showDiscount ? `<td class="r">${esc(disc)}</td>` : ''}
        <td class="r">${esc(rate)}</td>
        <td class="r">${esc(money(a.net, d.currency))}</td></tr>`;
    })
    .join('');
  const totals = totalsRows(d)
    .map(([label, value, strong]) => `<tr class="${strong ? 'strong' : ''}"><td>${esc(label)}</td><td class="r">${esc(value)}</td></tr>`)
    .join('');
  const logo = typeof settings.logo === 'string' && settings.logo.startsWith('data:image/') ? settings.logo : '';
  const logoPos = settings.logoPosition === 'above' ? 'above' : 'right';
  const brand = `<header class="brand ${logoPos}">
        ${logo && logoPos === 'above' ? `<img class="logo" src="${esc(logo)}" alt="">` : ''}
        <div class="brand-name">${esc(c.name || '')}</div>
        ${logo && logoPos === 'right' ? `<img class="logo" src="${esc(logo)}" alt="">` : ''}
      </header>`;
  const footLine1 = [c.name, c.address.replace(/\s*\n\s*/g, ', '), c.ice && `${t('ice')}: ${c.ice}`, c.ifNr && `${t('ifNr')}: ${c.ifNr}`, c.email && `${t('email')}: ${c.email}`, c.phone && `${t('phone')}: ${c.phone}`].filter(Boolean).join(' · ');
  const footLine2 = c.bank ? `${t('bank')}: ${c.bank.replace(/\s*\n\s*/g, ' · ')}` : '';
  return `
    <article class="sheet" id="sheet">
      ${d.status !== 'final' ? `<div class="wm" aria-hidden="true">${esc(t('draftWatermark'))}</div>` : ''}
      ${brand}
      <section class="docrow">
        <div class="meta">
          <h2>${esc(typeLabel(d.type))}</h2>
          ${d.number ? `<div><strong>${esc(d.number)}</strong></div>` : ''}
          <div>${esc(t('issuedOn'))}: ${esc(formatDate(d.date))}</div>
          ${isInvoice ? `<div>${esc(t('dueOn'))}: ${esc(formatDate(d.dueDate) || '–')}</div>` : `<div>${esc(t('validTo'))}: ${esc(formatDate(d.validUntil) || '–')}</div>`}
        </div>
        <div class="to">
          <div class="small muted">${esc(t('client'))}</div>
          <strong>${esc(d.customer.name)}</strong>
          <div class="pre">${esc(d.customer.address)}</div>
          ${d.customer.ice ? `<div>${esc(t('ice'))}: ${esc(d.customer.ice)}</div>` : ''}
        </div>
      </section>
      ${d.extraInfo && d.extraInfo.trim() ? `<div class="extra"><strong>${esc(t('extraInfo'))} :</strong> <span class="pre">${esc(d.extraInfo.trim())}</span></div>` : ''}
      <table class="items">
        <thead><tr><th>${esc(t('thPos'))}</th><th>${esc(t('thDesc'))}</th><th class="r">${esc(t('thQty'))}</th><th class="r">${esc(t('thPrice'))}</th>${d.showDiscount ? `<th class="r">${esc(t('thDiscount'))}</th>` : ''}<th class="r">${esc(t('thTax'))}</th><th class="r">${esc(t('thNet'))} (${esc(d.currency)})</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <table class="sumtable"><tbody>${totals}</tbody></table>
      ${d.paymentTerms ? `<p><strong>${esc(t('terms'))}:</strong> ${esc(d.paymentTerms)}</p>` : ''}
      ${d.notes ? `<p class="pre">${esc(d.notes)}</p>` : ''}
      ${footLine1 || footLine2 ? `<footer class="foot">${footLine1 ? `<div>${esc(footLine1)}</div>` : ''}${footLine2 ? `<div>${esc(footLine2)}</div>` : ''}</footer>` : ''}
    </article>`;
}

function viewPreview(d) {
  return `
    <section class="stack">
      <div class="actions no-print">
        <a class="btn" href="#/edit/${esc(d.id)}">${esc(t('edit'))}</a>
        <button type="button" class="btn primary" data-action="print">${esc(t('print'))}</button>
      </div>
      <p class="muted small no-print">${esc(t('printHelp'))}</p>
      ${sheetHtml(d)}
    </section>`;
}

// ----- Dokumentliste -----

function viewDocs() {
  const q = state.search.trim().toLowerCase();
  const docs = store.listDocuments().filter((d) => {
    if (state.filter !== 'all' && d.type !== state.filter) return false;
    if (!q) return true;
    return `${d.number} ${d.customer.name}`.toLowerCase().includes(q);
  });
  const tab = (key, label) => `<button type="button" class="tab ${state.filter === key ? 'active' : ''}" data-action="filter" data-filter="${key}">${esc(label)}</button>`;
  const list = docs
    .map(
      (d) => `
      <li class="doc">
        ${docBody(d)}
        <div class="doc-actions">
          <a class="link" href="#/preview/${esc(d.id)}">${esc(t('preview'))}</a>
          <button type="button" class="link" data-action="duplicate" data-id="${esc(d.id)}">${esc(t('duplicate'))}</button>
          ${d.type === 'quote' ? `<button type="button" class="link" data-action="to-invoice" data-id="${esc(d.id)}">${esc(t('toInvoice'))}</button>` : ''}
          <button type="button" class="link danger" data-action="delete-doc" data-id="${esc(d.id)}">${esc(t('delete'))}</button>
        </div>
      </li>`,
    )
    .join('');
  return `
    <section class="stack">
      <h1>${esc(t('docsTitle'))}</h1>
      <div class="tabs">${tab('all', t('filterAll'))}${tab('invoice', t('invoices'))}${tab('quote', t('quotes'))}</div>
      <input type="search" id="docSearch" value="${esc(state.search)}" placeholder="${esc(t('search'))}">
      ${docs.length ? `<ul class="docs">${list}</ul>` : `<p class="muted">${esc(t('noDocs'))}</p>`}
    </section>`;
}

// ----- Einstellungen -----

function logoPreviewHtml() {
  const src = state.logoDraft !== undefined ? state.logoDraft : settings.logo;
  return src && src.startsWith('data:image/') ? `<img src="${esc(src)}" alt="">` : `<span class="muted small">${esc(t('logoNone'))}</span>`;
}

/** Verkleinert ein Bild (längste Seite höchstens 600 px) und liefert es als Data-URL. */
function fileToLogo(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const iw = img.naturalWidth || 300;
      const ih = img.naturalHeight || 150;
      const k = Math.min(1, 600 / Math.max(iw, ih));
      const w = Math.max(1, Math.round(iw * k));
      const h = Math.max(1, Math.round(ih * k));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      let out = canvas.toDataURL('image/png');
      if (out.length > 350000) {
        const c2 = document.createElement('canvas');
        c2.width = w;
        c2.height = h;
        const ctx = c2.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        out = c2.toDataURL('image/jpeg', 0.85);
      }
      if (out.length > 700000) reject(new Error('logoTooBig'));
      else resolve(out);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('logoFailed'));
    };
    img.src = url;
  });
}

function viewSettings() {
  const c = settings.company;
  const customers = store.listCustomers();
  const f = (name, label, value, extra = '') => field(label, `<input name="${name}" value="${esc(value)}" ${extra}>`);
  return `
    <section class="stack">
      <h1>${esc(t('settingsTitle'))}</h1>
      <form id="settingsForm" class="stack" autocomplete="off">
        <div class="card">
          <h2>${esc(t('company'))}</h2>
          ${f('companyName', t('companyName'), c.name)}
          ${field(t('companyAddress'), `<textarea name="companyAddress" rows="2">${esc(c.address)}</textarea>`)}
          <div class="grid2">${f('ice', t('ice'), c.ice, 'inputmode="numeric" autocomplete="off"')}${f('ifNr', t('ifNr'), c.ifNr, 'inputmode="numeric" autocomplete="off"')}</div>
          <div class="grid2">${f('email', t('email'), c.email, 'type="email"')}${f('phone', t('phone'), c.phone, 'type="tel"')}</div>
          ${field(t('bank'), `<textarea name="bank" rows="2">${esc(c.bank)}</textarea>`)}
        </div>
        <div class="card">
          <h2>${esc(t('logo'))}</h2>
          <div id="logoPreview" class="logo-preview">${logoPreviewHtml()}</div>
          <div class="actions">
            <label class="btn">${esc(t('logoUpload'))}<input type="file" id="logoFile" accept="image/*" hidden></label>
            <button type="button" class="btn" data-action="logo-remove">${esc(t('logoRemove'))}</button>
          </div>
          ${field(t('logoPosition'), `<select name="logoPosition"><option value="right" ${settings.logoPosition !== 'above' ? 'selected' : ''}>${esc(t('logoRight'))}</option><option value="above" ${settings.logoPosition === 'above' ? 'selected' : ''}>${esc(t('logoAbove'))}</option></select>`)}
          <p class="muted small">${esc(t('logoHelp'))}</p>
        </div>
        <div class="card">
          ${field(t('language'), `<select name="lang">${Object.entries(LANGUAGES).map(([k, v]) => `<option value="${k}" ${k === settings.lang ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select>`)}
          ${field(t('defaultCurrency'), `<select name="currency">${currencyOptions(settings.currency)}</select>`)}
          ${f('defaultTaxRate', t('defaultTax'), settings.defaultTaxRate, 'inputmode="decimal"')}
          <p class="muted small">${esc(t('defaultTaxHelp'))}</p>
          <div class="grid2">
            ${f('defaultPaymentDays', t('paymentDays'), settings.defaultPaymentDays, 'inputmode="numeric"')}
            ${f('quoteValidDays', t('validDays'), settings.quoteValidDays, 'inputmode="numeric"')}
          </div>
          <div class="grid2">
            ${f('invoicePrefix', t('invoicePrefix'), settings.invoicePrefix)}
            ${f('quotePrefix', t('quotePrefix'), settings.quotePrefix)}
          </div>
        </div>
        <div class="card">
          <h2>${esc(t('aiSection'))}</h2>
          <p class="muted small">${esc(t('aiSectionHelp'))}</p>
          ${field(t('aiMode'), `<select name="aiMode"><option value="direct" ${settings.aiMode !== 'proxy' ? 'selected' : ''}>${esc(t('aiModeDirect'))}</option><option value="proxy" ${settings.aiMode === 'proxy' ? 'selected' : ''}>${esc(t('aiModeProxy'))}</option></select>`)}
          ${f('geminiKey', t('geminiKey'), settings.geminiKey, 'type="password" autocomplete="off" autocapitalize="off" spellcheck="false"')}
          ${f('geminiModel', t('geminiModel'), settings.geminiModel, 'placeholder="gemini-2.5-flash" autocapitalize="off" spellcheck="false"')}
          <p class="muted small">${esc(t('geminiHelp'))}</p>
          ${f('aiEndpoint', t('aiEndpoint'), settings.aiEndpoint, 'type="url" inputmode="url" placeholder="https://…"')}
          ${f('aiToken', t('aiToken'), settings.aiToken, 'type="password" autocomplete="off"')}
        </div>
        <div class="actions"><button type="submit" class="btn primary">${esc(t('save'))}</button></div>
      </form>

      <div class="card">
        <h2>${esc(t('backup'))}</h2>
        <div class="actions">
          <button type="button" class="btn" data-action="export">${esc(t('exportData'))}</button>
          <label class="btn">${esc(t('importData'))}<input type="file" id="importFile" accept="application/json,.json" hidden></label>
        </div>
      </div>

      <div class="card">
        <h2>${esc(t('customers'))}</h2>
        ${customers.length
          ? `<ul class="plain">${customers.map((cu) => `<li><span>${esc(cu.name)}</span><button type="button" class="link danger" data-action="delete-customer" data-id="${esc(cu.id)}">${esc(t('delete'))}</button></li>`).join('')}</ul>`
          : `<p class="muted small">${esc(t('noCustomers'))}</p>`}
      </div>
    </section>`;
}

// ---------- Aktionen ----------

function cloneAsNew(doc, type) {
  const base = newDocument(type, settings, todayIso());
  return {
    ...base,
    customer: { ...doc.customer },
    showDiscount: Boolean(doc.showDiscount),
    extraInfo: doc.extraInfo || '',
    currency: doc.currency,
    notes: doc.notes,
    lines: doc.lines.map((l) => ({ ...l, id: newId('l') })),
  };
}

function saveDraftAction() {
  const d = state.draft;
  const saved = persist({ ...d, status: 'draft' });
  if (!saved) return;
  state.draft = saved;
  state.dirty = false;
  toast(t('saved'), 'ok');
  rerenderEditorKeepScroll();
}

function finalizeAction() {
  const d = state.draft;
  const issues = checkDocument(d);
  state.showIssues = true;
  if (hasErrors(issues)) {
    rerenderEditorKeepScroll();
    toast(t('cannotFinalize'), 'error');
    $('#issues')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }
  const year = Number(d.date.slice(0, 4));
  let number = d.number;
  try {
    if (!number) number = store.nextNumber(d.type, year, settings);
  } catch {
    toast(t('storageFull'), 'error');
    return;
  }
  const saved = persist({ ...d, number, status: 'final' });
  if (!saved) return;
  state.draft = saved;
  state.dirty = false;
  state.showIssues = false;
  toast(t('finalized', { number }), 'ok');
  go(`#/preview/${saved.id}`);
}

function rerenderEditorKeepScroll() {
  const y = window.scrollY;
  main().innerHTML = viewEditor();
  refreshLive();
  window.scrollTo(0, y);
}

async function runAi() {
  if (state.aiBusy) return;
  const text = state.aiText.trim();
  const setStatus = (key, kind = 'warn', extra = '') => {
    state.aiStatus = { key, kind, extra };
    const el = $('#aiStatus');
    if (el) el.outerHTML = aiStatusHtml();
  };
  if (!text) return setStatus('aiEmpty');
  if (!isAiConfigured(settings)) return setStatus('aiNotConfigured');
  if (navigator.onLine === false) return setStatus('aiOffline');
  if (hasContent(state.draft) && !window.confirm(t('aiReplaceConfirm'))) return;

  state.aiBusy = true;
  state.aiStatus = null;
  $('#aiRun').disabled = true;
  $('#aiStatus').outerHTML = aiStatusHtml();

  const old = state.draft;
  const provider = createProvider(settings);
  const payload = old.type === 'quote' ? `Dokumententyp: Angebot. ${text}` : text;
  try {
    const result = await extractDocumentData(provider, payload, { today: todayIso(), lang: getLang() });
    if (!result.ok) {
      const paths = result.errors.slice(0, 4).map((e) => e.path || e.code).join(', ');
      state.aiBusy = false;
      $('#aiRun').disabled = false;
      return setStatus('aiInvalid', 'error', paths);
    }
    const next = draftFromAi(result.data, settings, todayIso());
    next.id = old.id;
    next.number = old.number;
    next.createdAt = old.createdAt;
    if (next.type !== old.type) next.hints.unshift({ code: 'typeSwitched', params: { type: typeLabel(next.type) } });
    state.draft = next;
    state.aiBusy = false;
    state.showIssues = false;
    state.aiStatus = { key: 'aiDone', kind: 'ok' };
    rerenderEditorKeepScroll();
    state.dirty = true;
    $('#hints')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    state.aiBusy = false;
    $('#aiRun').disabled = false;
    if (e instanceof AiError) {
      const key = e.kind === 'notConfigured' ? 'aiNotConfigured' : e.kind === 'offline' ? 'aiOffline' : `aiError_${e.kind}`;
      return setStatus(key, 'error', e.message !== e.kind ? e.message : '');
    }
    return setStatus('aiFailed', 'error');
  }
}

function download(filename, text, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function readSettingsForm(form) {
  const v = (n) => form.elements[n].value.trim();
  const intOr = (n, fallback) => {
    const x = Number.parseInt(v(n), 10);
    return Number.isFinite(x) && x >= 0 ? x : fallback;
  };
  const rate = v('defaultTaxRate');
  return {
    ...settings,
    lang: v('lang'),
    currency: v('currency'),
    defaultTaxRate: rate === '' ? '' : String(parseDecimal(rate, PCT_SCALE) === null ? '' : rate.replace(',', '.')),
    defaultPaymentDays: intOr('defaultPaymentDays', 14),
    quoteValidDays: intOr('quoteValidDays', 30),
    invoicePrefix: v('invoicePrefix') || 'RE',
    quotePrefix: v('quotePrefix') || 'AN',
    logo: state.logoDraft !== undefined ? state.logoDraft : settings.logo || '',
    logoPosition: v('logoPosition') === 'above' ? 'above' : 'right',
    aiMode: v('aiMode') === 'proxy' ? 'proxy' : 'direct',
    geminiKey: v('geminiKey'),
    geminiModel: v('geminiModel'),
    aiEndpoint: v('aiEndpoint'),
    aiToken: v('aiToken'),
    company: {
      name: v('companyName'),
      address: form.elements.companyAddress.value.trim(),
      ice: v('ice'),
      ifNr: v('ifNr'),
      email: v('email'),
      phone: v('phone'),
      bank: form.elements.bank.value.trim(),
    },
  };
}

function onClick(e) {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;
  const d = state.draft;
  switch (action) {
    case 'add-line':
      d.lines.push(emptyLine(settings));
      state.dirty = true;
      rerenderEditorKeepScroll();
      break;
    case 'remove-line': {
      const i = Number(el.dataset.i);
      if (d.lines.length > 1) d.lines.splice(i, 1);
      else d.lines[0] = emptyLine(settings);
      state.dirty = true;
      rerenderEditorKeepScroll();
      break;
    }
    case 'ai-run':
      runAi();
      break;
    case 'save-draft':
      saveDraftAction();
      break;
    case 'finalize':
      finalizeAction();
      break;
    case 'preview':
      go(`#/preview/${d.id}`);
      break;
    case 'print':
      window.print();
      break;
    case 'filter':
      state.filter = el.dataset.filter;
      main().innerHTML = viewDocs();
      break;
    case 'duplicate': {
      const src = store.getDocument(el.dataset.id);
      if (!src) break;
      const copy = cloneAsNew(src, src.type);
      state.draft = copy;
      state.dirty = true;
      go(`#/edit/${copy.id}`);
      break;
    }
    case 'to-invoice': {
      const src = store.getDocument(el.dataset.id);
      if (!src) break;
      const copy = cloneAsNew(src, 'invoice');
      state.draft = copy;
      state.dirty = true;
      go(`#/edit/${copy.id}`);
      break;
    }
    case 'delete-doc': {
      const doc = store.getDocument(el.dataset.id);
      if (!doc) break;
      const msg = doc.status === 'final' && doc.number ? t('deleteFinalConfirm', { number: doc.number }) : t('deleteConfirm');
      if (!window.confirm(msg)) break;
      store.deleteDocument(doc.id);
      if (state.draft?.id === doc.id) {
        state.draft = null;
        state.dirty = false;
      }
      toast(t('deleted'), 'ok');
      main().innerHTML = viewDocs();
      break;
    }
    case 'delete-customer':
      store.deleteCustomer(el.dataset.id);
      main().innerHTML = viewSettings();
      break;
    case 'logo-remove':
      state.logoDraft = '';
      $('#logoPreview').innerHTML = logoPreviewHtml();
      break;
    case 'export':
      download(`rechnungs-app-sicherung-${todayIso()}.json`, JSON.stringify(store.exportAll(), null, 2));
      break;
    default:
  }
}

function onField(e) {
  const el = e.target;
  if (el.id === 'aiText') {
    state.aiText = el.value;
    return;
  }
  if (el.id === 'docSearch') {
    state.search = el.value;
    const pos = el.selectionStart;
    main().innerHTML = viewDocs();
    const again = $('#docSearch');
    again.focus();
    again.setSelectionRange(pos, pos);
    return;
  }
  const d = state.draft;
  if (!d) return;
  if (el.dataset.toggleDiscount !== undefined) {
    if (e.type !== 'change') return;
    const hasValues = d.lines.some((l) => String(l.discount).trim() !== '');
    if (!el.checked && hasValues && !window.confirm(t('discountClearConfirm'))) {
      el.checked = true;
      return;
    }
    d.showDiscount = el.checked;
    if (!el.checked) d.lines.forEach((l) => { l.discount = ''; l.discountType = 'amount'; });
    state.dirty = true;
    rerenderEditorKeepScroll();
    return;
  }
  if (el.dataset.reviewed !== undefined) {
    d.reviewed = el.checked;
    state.dirty = true;
    refreshLive();
    return;
  }
  const f = el.dataset.f;
  if (!f) return;

  state.dirty = true;
  const prevAuto = autoDue(d);
  if (el.dataset.line !== undefined) {
    const line = d.lines[Number(el.dataset.line)];
    if (!line) return;
    line[f] = el.value;
  } else {
    setPath(d, f, el.value);
  }

  if (d.type === 'invoice' && (f === 'date' || f === 'paymentTerms')) {
    const next = autoDue(d);
    if (next && (d.dueDate === '' || d.dueDate === prevAuto)) {
      d.dueDate = next;
      const dueEl = $('[data-f="dueDate"]');
      if (dueEl) dueEl.value = next;
    }
  }

  if (f === 'customer.name' && e.type === 'change') {
    const known = store.listCustomers().find((c) => c.name.toLowerCase() === el.value.trim().toLowerCase());
    if (known && !d.customer.address.trim()) {
      d.customer.address = known.address;
      const addr = $('[data-f="customer.address"]');
      if (addr) addr.value = known.address;
    }
    if (known?.ice && !(d.customer.ice || '').trim()) {
      d.customer.ice = known.ice;
      const iceEl = $('[data-f="customer.ice"]');
      if (iceEl) iceEl.value = known.ice;
    }
  }
  refreshLive();
}

function onSubmit(e) {
  if (e.target.id !== 'settingsForm') return;
  e.preventDefault();
  try {
    settings = readSettingsForm(e.target);
    store.saveSettings(settings);
  } catch {
    toast(t('storageFull'), 'error');
    return;
  }
  state.logoDraft = undefined;
  setLang(settings.lang);
  render();
  toast(t('settingsSaved'), 'ok');
}

async function onLogoChange(e) {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  try {
    state.logoDraft = await fileToLogo(file);
    $('#logoPreview').innerHTML = logoPreviewHtml();
  } catch (err) {
    toast(t(err.message === 'logoTooBig' ? 'logoTooBig' : 'logoFailed'), 'error');
  }
}

function onFileChange(e) {
  if (e.target.id === 'logoFile') {
    onLogoChange(e);
    return;
  }
  if (e.target.id !== 'importFile') return;
  const file = e.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(String(reader.result));
      if (!window.confirm(t('importConfirm'))) return;
      store.importAll(data);
      settings = store.getSettings();
      setLang(settings.lang);
      state.draft = null;
      state.dirty = false;
      toast(t('importDone'), 'ok');
      render();
    } catch {
      toast(t('importFailed'), 'error');
    }
  };
  reader.readAsText(file);
}

// ---------- Start ----------

function init() {
  const root = document.getElementById('app');
  root.addEventListener('click', onClick);
  root.addEventListener('input', onField);
  root.addEventListener('change', (e) => {
    onField(e);
    onFileChange(e);
  });
  root.addEventListener('submit', onSubmit);
  window.addEventListener('hashchange', render);
  window.addEventListener('online', updateOnline);
  window.addEventListener('offline', updateOnline);
  window.addEventListener('pagehide', autosaveIfNeeded);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') autosaveIfNeeded();
  });
  render();

  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

init();
