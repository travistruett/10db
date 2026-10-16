import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderJsonSchemas } from '../src/index';

const outDir = resolve(import.meta.dirname, '../generated');
mkdirSync(outDir, { recursive: true });
const rendered = renderJsonSchemas();
for (const stale of readdirSync(outDir).filter((f) => !rendered.has(f)))
  rmSync(resolve(outDir, stale));
for (const [file, text] of rendered) writeFileSync(resolve(outDir, file), text);
console.log(`Wrote ${String(rendered.size)} schema file(s) to packages/contracts/generated`);
