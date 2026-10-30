// Lokale Speicherung im Browser (localStorage). Alles bleibt auf dem Gerät.
import { DEFAULT_SETTINGS, formatNumber, newId } from './model.js';

const KEYS = {
  settings: 'ra.settings.v1',
  docs: 'ra.docs.v1',
  customers: 'ra.customers.v1',
  counters: 'ra.counters.v1',
};

export class Store {
  /** @param {Storage} storage localStorage oder ein Ersatz mit getItem/setItem */
  constructor(storage) {
    this.storage = storage;
  }

  _read(key, fallback) {
    try {
      const raw = this.storage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }

  _write(key, value) {
    // Wirft bei vollem Speicher; die App zeigt den Fehler an.
    this.storage.setItem(key, JSON.stringify(value));
  }

  // ----- Einstellungen -----
  getSettings() {
    const s = this._read(KEYS.settings, {});
    const company = { ...DEFAULT_SETTINGS.company, ...(s.company || {}) };
    if (!company.ice && s.company?.taxId) company.ice = s.company.taxId; // ältere Version
    delete company.taxId;
    return { ...DEFAULT_SETTINGS, ...s, company };
  }

  saveSettings(settings) {
    this._write(KEYS.settings, settings);
  }

  // ----- Dokumente -----
  listDocuments() {
    return this._read(KEYS.docs, []).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  }

  getDocument(id) {
    return this._read(KEYS.docs, []).find((d) => d.id === id) || null;
  }

  saveDocument(doc) {
    const docs = this._read(KEYS.docs, []);
    const stored = { ...doc, updatedAt: new Date().toISOString() };
    const i = docs.findIndex((d) => d.id === doc.id);
    if (i === -1) docs.push(stored);
    else docs[i] = stored;
    this._write(KEYS.docs, docs);
    return stored;
  }

  deleteDocument(id) {
    this._write(KEYS.docs, this._read(KEYS.docs, []).filter((d) => d.id !== id));
  }

  // ----- Nummern: fortlaufend je Typ und Jahr, vergeben erst beim Fertigstellen -----
  nextNumber(type, year, settings) {
    const counters = this._read(KEYS.counters, {});
    const key = `${type}-${year}`;
    const next = (counters[key] || 0) + 1;
    counters[key] = next;
    this._write(KEYS.counters, counters);
    const prefix = type === 'invoice' ? settings.invoicePrefix || 'RE' : settings.quotePrefix || 'AN';
    return formatNumber(prefix, year, next);
  }

  // ----- Kunden -----
  listCustomers() {
    return this._read(KEYS.customers, []).sort((a, b) => a.name.localeCompare(b.name));
  }

  upsertCustomer(customer) {
    const name = (customer.name || '').trim();
    if (!name) return;
    const list = this._read(KEYS.customers, []);
    const i = list.findIndex((c) => c.name.toLowerCase() === name.toLowerCase());
    const entry = { id: i === -1 ? newId('c') : list[i].id, name, address: (customer.address || '').trim(), ice: (customer.ice || '').trim() };
    if (i === -1) list.push(entry);
    else list[i] = entry;
    this._write(KEYS.customers, list);
  }

  deleteCustomer(id) {
    this._write(KEYS.customers, this._read(KEYS.customers, []).filter((c) => c.id !== id));
  }

  // ----- Datensicherung -----
  exportAll() {
    return {
      app: 'rechnungs-app',
      version: 1,
      exportedAt: new Date().toISOString(),
      settings: { ...this.getSettings(), aiToken: '', geminiKey: '' }, // Schlüssel nicht in Sicherungen schreiben
      documents: this._read(KEYS.docs, []),
      customers: this._read(KEYS.customers, []),
      counters: this._read(KEYS.counters, {}),
    };
  }

  importAll(data) {
    if (!data || data.app !== 'rechnungs-app' || !Array.isArray(data.documents)) {
      throw new Error('invalidBackup');
    }
    const current = this.getSettings();
    this._write(KEYS.settings, { ...current, ...data.settings, aiToken: current.aiToken, geminiKey: current.geminiKey, aiEndpoint: data.settings?.aiEndpoint || current.aiEndpoint });
    this._write(KEYS.docs, data.documents);
    this._write(KEYS.customers, Array.isArray(data.customers) ? data.customers : []);
    this._write(KEYS.counters, data.counters && typeof data.counters === 'object' ? data.counters : {});
  }
}
