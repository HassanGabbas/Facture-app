// Aufruf der Google-Gemini-API (generateContent). Wird vom Proxy (worker/) und direkt von der App genutzt.
// Wirft bei Fehlern { status, code, detail } – detail ist die (gekürzte) Fehlermeldung von Google, nie der Schlüssel.
export const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';
// Wird nur verwendet, wenn kein Modell fest eingestellt ist und das Standardmodell nicht (mehr) existiert.
export const FALLBACK_MODELS = ['gemini-flash-latest', 'gemini-2.0-flash'];

const short = (s) => String(s || '').replace(/\s+/g, ' ').slice(0, 220);

async function errorDetail(res) {
  try {
    const body = await res.json();
    return short(body?.error?.message || body?.error?.status || '');
  } catch {
    return '';
  }
}

async function requestOnce({ apiKey, model, system, text, fetchImpl, signal, withThinking }) {
  const generationConfig = { responseMimeType: 'application/json', temperature: 0, maxOutputTokens: 8192 };
  // Kein "Denken": die Denk-Token würden sonst von der Antwortgrenze abgehen und die Antwort leer lassen.
  if (withThinking && /flash/i.test(model)) generationConfig.thinkingConfig = { thinkingBudget: 0 };
  return fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text }] }],
      generationConfig,
    }),
    signal,
  });
}

export async function callGemini({ apiKey, model, system, text, fetchImpl = (...a) => fetch(...a), timeoutMs = 40000 }) {
  if (!apiKey) throw { status: 401, code: 'missing_key' };
  const candidates = model ? [model] : [DEFAULT_GEMINI_MODEL, ...FALLBACK_MODELS];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let lastError = { status: 502, code: 'upstream_error', detail: '' };

  try {
    for (const name of candidates) {
      let res;
      try {
        res = await requestOnce({ apiKey, model: name, system, text, fetchImpl, signal: controller.signal, withThinking: true });
        if (res.status === 400) {
          const d = await errorDetail(res.clone());
          // Manche Modelle kennen die Denk-Einstellung nicht: einmal ohne wiederholen.
          if (!/api key/i.test(d)) res = await requestOnce({ apiKey, model: name, system, text, fetchImpl, signal: controller.signal, withThinking: false });
        }
      } catch (e) {
        const aborted = e?.name === 'AbortError';
        throw { status: aborted ? 504 : 502, code: aborted ? 'upstream_timeout' : 'upstream_unreachable', detail: short(e?.message) };
      }

      if (!res.ok) {
        const detail = await errorDetail(res);
        if (res.status === 401 || res.status === 403 || (res.status === 400 && /api key/i.test(detail))) {
          throw { status: 401, code: 'upstream_key_rejected', detail };
        }
        if (res.status === 429) throw { status: 429, code: 'upstream_rate_limited', detail };
        lastError = { status: 502, code: 'upstream_error', detail: `${name}: HTTP ${res.status}${detail ? ' – ' + detail : ''}` };
        if (res.status === 404 && candidates.length > 1) continue; // Modell unbekannt: nächstes versuchen
        throw lastError;
      }

      let data;
      try {
        data = await res.json();
      } catch {
        throw { status: 502, code: 'upstream_invalid', detail: `${name}: keine gültige Antwort` };
      }
      const parts = data?.candidates?.[0]?.content?.parts;
      const out = (Array.isArray(parts) ? parts : []).map((p) => (typeof p?.text === 'string' ? p.text : '')).join('');
      if (!out.trim()) {
        const why = data?.promptFeedback?.blockReason || data?.candidates?.[0]?.finishReason || 'leer';
        throw { status: 502, code: 'upstream_empty', detail: `${name}: leere Antwort (${why})` };
      }
      return out;
    }
    throw lastError;
  } finally {
    clearTimeout(timer);
  }
}
