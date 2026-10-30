// Erzeugt js/prompt.js aus docs/system-prompt.txt.
// Einzige technische Anpassung gegenüber dem Original: das feste Datum wird zum Platzhalter {{TODAY}},
// damit App und Proxy bei jeder Anfrage das aktuelle Datum des Nutzers einsetzen kann.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const original = readFileSync(join(root, 'docs', 'system-prompt.txt'), 'utf8');
const templated = original.replaceAll('2026-10-29', '{{TODAY}}');
const count = (original.match(/2026-10-29/g) || []).length;
if (count === 0) throw new Error('Kein festes Datum im Prompt gefunden.');

const out = `// AUTOMATISCH ERZEUGT durch scripts/build-prompt.js aus docs/system-prompt.txt. Nicht von Hand ändern.
export const SYSTEM_PROMPT_TEMPLATE = ${JSON.stringify(templated)};

export function buildSystemPrompt(today) {
  return SYSTEM_PROMPT_TEMPLATE.replaceAll('{{TODAY}}', today);
}
`;
writeFileSync(join(root, 'js', 'prompt.js'), out);
console.log(`js/prompt.js erzeugt (${count} Datumsstellen ersetzt).`);
