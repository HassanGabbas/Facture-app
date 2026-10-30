// Aufruf der Google-Gemini-API (generateContent). Wird vom Proxy (worker/) und direkt von der App genutzt.
// Wirft bei Fehlern { status, code } ohne Details des Anbieters.
export const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';

export async function callGemini({ apiKey, model, system, text, fetchImpl = (...a) => fetch(...a), timeoutMs = 40000 }) {
  if (!apiKey) throw { status: 401, code: 'missing_key' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const name = encodeURIComponent(model || DEFAULT_GEMINI_MODEL);
  let res;
  try {
    res = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${name}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0, maxOutputTokens: 4000 },
      }),
      signal: controller.signal,
    });
  } catch (e) {
    const aborted = e?.name === 'AbortError';
    throw { status: aborted ? 504 : 502, code: aborted ? 'upstream_timeout' : 'upstream_unreachable' };
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    let message = '';
    try {
      message = (await res.json())?.error?.message || '';
    } catch { /* ignorieren */ }
    if (res.status === 401 || res.status === 403 || (res.status === 400 && /api key/i.test(message))) {
      throw { status: 401, code: 'upstream_key_rejected' };
    }
    if (res.status === 429) throw { status: 429, code: 'upstream_rate_limited' };
    throw { status: 502, code: 'upstream_error' };
  }

  let data;
  try {
    data = await res.json();
  } catch {
    throw { status: 502, code: 'upstream_invalid' };
  }
  const parts = data?.candidates?.[0]?.content?.parts;
  const out = (Array.isArray(parts) ? parts : []).map((p) => (typeof p?.text === 'string' ? p.text : '')).join('');
  if (!out.trim()) throw { status: 502, code: 'upstream_empty' };
  return out;
}
