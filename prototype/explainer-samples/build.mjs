// PROTOTYPE build: inlines logic.js, data.js and app.js into one self-contained index.html.
// Usage: node build.mjs   (run from this folder)
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const read = f => readFileSync(join(here, f), 'utf8');
const logic = read('logic.js').replace(/^export /gm, '');
const html = read('template.html')
  .replace('/*LOGIC*/', () => logic)
  .replace('/*DATA*/', () => read('data.js'))
  .replace('/*APP*/', () => read('app.js'));
writeFileSync(join(here, 'index.html'), html);
console.log(`wrote index.html (${html.length} bytes)`);
