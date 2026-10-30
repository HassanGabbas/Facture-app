// Baut dist/rechnungs-app.html: App, Styles und Skripte in EINER Datei (läuft auch per file://, ohne Server).
const { build } = await import(process.env.ESBUILD_PATH || 'esbuild');
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const js = (await build({ entryPoints: ['js/app.js'], bundle: true, format: 'iife', write: false, target: 'es2020', minify: true })).outputFiles[0].text;
const css = readFileSync('styles.css', 'utf8');
let html = readFileSync('index.html', 'utf8');
html = html
  .replace(/<link rel="manifest"[^>]*>\n?/, '')
  .replace(/<link rel="apple-touch-icon"[^>]*>\n?/, '')
  .replace(/<link rel="icon"[^>]*>/, '<link rel="icon" href="data:image/svg+xml;base64,' + Buffer.from(readFileSync('icons/icon.svg')).toString('base64') + '">')
  .replace('<link rel="stylesheet" href="styles.css">', () => `<style>\n${css}\n</style>`)
  .replace('<script type="module" src="js/app.js"></script>', () => `<script>\n${js.replace(/<\/script/gi, '<\\/script')}\n</script>`)
  .replace('Diese App benötigt JavaScript.', 'Diese App benötigt JavaScript. Bitte die Datei im Browser (Chrome) öffnen, nicht in einer Vorschau.');
mkdirSync('dist', { recursive: true });
writeFileSync('dist/rechnungs-app.html', html);
console.log('dist/rechnungs-app.html', Math.round(html.length / 1024) + ' KB');
