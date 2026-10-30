// Austauschbare KI-Schnittstelle.
//
// Ein Provider ist ein Objekt mit:  { name, extract({ text, today, lang }) -> Promise<object | string> }
// Provider "gemini-direct": die App ruft Gemini mit dem Schlüssel des Nutzers auf (nur im Gerätespeicher, nie im App-Code).
// Provider "proxy": spricht einen eigenen kleinen Server an (siehe worker/); dort liegt der Schlüssel.
// Ein anderer Anbieter wird durch einen weiteren Provider (oder einen anderen Proxy) ersetzt;
// der Rest der App ändert sich nicht.
import { validateAiResponse } from './model.js';
import { callGemini } from './gemini.js';
import { buildSystemPrompt } from './prompt.js';

export const MAX_TEXT_LENGTH = 4000;

export class AiError extends Error {
  /** kind: notConfigured | offline | network | unauthorized | rate | server | timeout | tooLong | response */
  constructor(kind, detail = '') {
    super(detail || kind);
    this.kind = kind;
  }
}

export function createProxyProvider({ endpoint, token = '', fetchImpl = (...a) => fetch(...a), timeoutMs = 45000 }) {
  return {
    name: 'proxy',
    async extract({ text, today, lang }) {
      if (!endpoint || !/^https?:\/\//i.test(endpoint)) throw new AiError('notConfigured');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let res;
      try {
        res = await fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ text, today, lang }),
          signal: controller.signal,
        });
      } catch (e) {
        if (e?.name === 'AbortError') throw new AiError('timeout');
        throw new AiError('network', e?.message);
      } finally {
        clearTimeout(timer);
      }

      if (res.status === 401 || res.status === 403) throw new AiError('unauthorized');
      if (res.status === 429) throw new AiError('rate');
      if (res.status === 413) throw new AiError('tooLong');
      if (!res.ok) throw new AiError('server', `HTTP ${res.status}`);

      let body;
      try {
        body = await res.json();
      } catch {
        throw new AiError('response', 'no json body');
      }
      if (body === null || typeof body !== 'object' || !('result' in body)) throw new AiError('response', 'missing result');
      return body.result;
    },
  };
}

/**
 * Direkt-Modus: Die App ruft Gemini selbst mit dem Schlüssel des Nutzers auf (nur im lokalen Gerätespeicher abgelegt).
 * Gedacht für den persönlichen Gebrauch mit einem kostenlosen Schlüssel ohne hinterlegte Zahlungsmethode.
 */
export function createGeminiProvider({ apiKey, model = '', fetchImpl = (...a) => fetch(...a) }) {
  return {
    name: 'gemini-direct',
    async extract({ text, today }) {
      if (!apiKey) throw new AiError('notConfigured');
      try {
        return await callGemini({ apiKey, model, system: buildSystemPrompt(today), text, fetchImpl });
      } catch (e) {
        if (e instanceof AiError) throw e;
        if (e?.status === 401) throw new AiError('unauthorized');
        if (e?.status === 429) throw new AiError('rate');
        if (e?.status === 504) throw new AiError('timeout');
        if (e?.status === 502 && e?.code === 'upstream_unreachable') throw new AiError('network');
        if (e?.status) throw new AiError('server', e.code);
        throw new AiError('network', e?.message);
      }
    },
  };
}

export function createProvider(settings) {
  return settings.aiMode === 'proxy'
    ? createProxyProvider({ endpoint: settings.aiEndpoint, token: settings.aiToken })
    : createGeminiProvider({ apiKey: settings.geminiKey, model: settings.geminiModel });
}

export function isAiConfigured(settings) {
  return settings.aiMode === 'proxy' ? Boolean(settings.aiEndpoint) : Boolean(settings.geminiKey);
}

/**
 * Schickt den Freitext an den Provider und prüft die Antwort.
 * Rückgabe: { ok: true, data } oder { ok: false, errors } (Struktur der Antwort ungültig).
 * Netzwerk- und Dienstfehler werden als AiError geworfen.
 */
export async function extractDocumentData(provider, text, { today, lang }) {
  const clean = (text || '').trim();
  if (!clean) throw new AiError('response', 'empty text');
  if (clean.length > MAX_TEXT_LENGTH) throw new AiError('tooLong');
  if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new AiError('offline');
  const raw = await provider.extract({ text: clean, today, lang });
  return validateAiResponse(raw);
}
