// Lokaler Entwicklungsserver: liefert die App aus und stellt unter /api/extract denselben KI-Proxy bereit.
//   GEMINI_API_KEY=... APP_TOKEN=geheim node server.js
// Ohne GEMINI_API_KEY läuft die App trotzdem; nur die KI-Funktion meldet dann einen Serverfehler.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleExtract } from './worker/handler.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
};
// Nur diese Verzeichnisse und Dateien werden ausgeliefert (kein worker/, tests/, scripts/ usw.).
const PUBLIC = [/^\/$/, /^\/index\.html$/, /^\/styles\.css$/, /^\/sw\.js$/, /^\/manifest\.webmanifest$/, /^\/js\/[\w.-]+\.js$/, /^\/icons\/[\w.-]+$/];

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (url.pathname === '/api/extract') {
      const chunks = [];
      let size = 0;
      for await (const c of req) {
        size += c.length;
        if (size > 64 * 1024) {
          res.writeHead(413).end();
          return;
        }
        chunks.push(c);
      }
      const request = new Request(url, {
        method: req.method,
        headers: req.headers,
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
      });
      const response = await handleExtract(request, process.env);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
      return;
    }

    let path = decodeURIComponent(url.pathname);
    if (!PUBLIC.some((re) => re.test(path))) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
    if (path === '/') path = '/index.html';
    const file = normalize(join(ROOT, path));
    if (!file.startsWith(ROOT.endsWith(sep) ? ROOT : ROOT + sep)) {
      res.writeHead(403).end();
      return;
    }
    await stat(file);
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Rechnungs-App läuft auf http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(process.env.GEMINI_API_KEY ? 'KI-Proxy aktiv unter /api/extract' : 'Hinweis: GEMINI_API_KEY nicht gesetzt, KI-Funktion nicht verfügbar.');
});
