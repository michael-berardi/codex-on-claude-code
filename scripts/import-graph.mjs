// Lists every file the bin entry imports (run from the repository root), then any claude-code/ file it does not reach.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
const root = process.cwd(), seen = new Set();
function visit(file) {
  file = resolve(file); if (seen.has(file)) return; seen.add(file);
  const source = readFileSync(file, 'utf8');
  for (const match of source.matchAll(/(?:from\s*|import\s*\(|new URL\s*\()\s*["'](\.{1,2}\/[^"']+)["']/g)) visit(resolve(dirname(file), match[1]));
}
visit('bin/codex-on-claude-code');
for (const file of [...seen].sort()) console.log(relative(root, file));
for (const file of readdirSync('claude-code')) if (/\.(?:mjs|js)$/.test(file) && !seen.has(resolve('claude-code', file))) console.log(`UNREFERENCED ${file}`);
