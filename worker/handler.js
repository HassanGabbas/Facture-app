// Sicherer Proxy zwischen App und KI-Anbieter.
// Der API-Schlüssel liegt nur hier (Umgebungsvariable), niemals in der App.
// Läuft unverändert als Cloudflare Worker (worker.js) und lokal im Dev-Server (server.js).
//
// Anfrage:  POST  { "text": "...", "today": "YYYY-MM-DD", "lang": "de" }  mit  Authorization: Bearer <APP_TOKEN>
// Antwort:  200   { "result": "<JSON-Text des Modells>" }
//
// KI-Anbieter: Google Gemini (js/gemini.js). Anderen Anbieter verwenden: den Aufruf von callGemini() unten ersetzen.
import { buildSystemPrompt } from '../js/prompt.js';
import { callGemini } from '../js/gemini.js';

export const LIMITS = { bodyBytes: 16 * 1024, textChars: 4000, timeoutMs: 40000 };
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin');
  const allowed = (env.ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim()).filter(Boolean);
  const headers = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  if (allowed.includes('*')) headers['Access-Control-Allow-Origin'] = '*';
  else if (origin && allowed.includes(origin)) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

function json(request, env, status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...corsHeaders(request, env) },
  });
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function isValidDate(s) {
  if (typeof s !== 'string' || !ISO_DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export async function handleExtract(request, env = {}, fetchImpl = (...a) => fetch(...a)) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(request, env) });
  if (request.method !== 'POST') return json(request, env, 405, { error: 'method_not_allowed' });

  if (!env.GEMINI_API_KEY) return json(request, env, 500, { error: 'server_missing_api_key' });
  if (!env.APP_TOKEN && env.ALLOW_NO_TOKEN !== '1') return json(request, env, 500, { error: 'server_missing_app_token' });

  if (env.APP_TOKEN) {
    const auth = request.headers.get('Authorization') || '';
    const given = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!safeEqual(given, env.APP_TOKEN)) return json(request, env, 401, { error: 'unauthorized' });
  }

  let raw;
  try {
    raw = await request.text();
  } catch {
    return json(request, env, 400, { error: 'bad_request' });
  }
  if (new TextEncoder().encode(raw).length > LIMITS.bodyBytes) return json(request, env, 413, { error: 'too_large' });

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return json(request, env, 400, { error: 'bad_json' });
  }
  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  if (!text) return json(request, env, 400, { error: 'text_required' });
  if (text.length > LIMITS.textChars) return json(request, env, 413, { error: 'text_too_long' });

  const today = isValidDate(body.today) ? body.today : new Date().toISOString().slice(0, 10);

  try {
    const result = await callGemini({ apiKey: env.GEMINI_API_KEY, model: env.MODEL, system: buildSystemPrompt(today), text, fetchImpl, timeoutMs: LIMITS.timeoutMs });
    return json(request, env, 200, { result });
  } catch (e) {
    const status = e?.status || 500;
    return json(request, env, status, { error: e?.code || 'internal_error' });
  }
}
