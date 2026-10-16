// Prints one line per check and writes the evidence file out/<script>.json; exits 1 on any FAIL.
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

type Line = { level: 'PASS' | 'FAIL' | 'PARTIAL' | 'INFO'; name: string; detail: unknown };
const lines: Line[] = [];
const outDir = join(import.meta.dirname, '..', 'out');

function emit(line: Line): void {
  lines.push(line);
  const detail = typeof line.detail === 'string' ? line.detail : JSON.stringify(line.detail);
  console.log(`${line.level} ${line.name}: ${detail}`);
}

export function check(name: string, ok: boolean, detail: string): void {
  emit({ level: ok ? 'PASS' : 'FAIL', name, detail });
}

export function partial(name: string, detail: string): void {
  emit({ level: 'PARTIAL', name, detail });
}

export function info(name: string, detail: unknown): void {
  emit({ level: 'INFO', name, detail });
}

export function finish(): never {
  mkdirSync(outDir, { recursive: true });
  const script = basename(process.argv[1] ?? 'unknown', '.ts');
  writeFileSync(join(outDir, `${script}.json`), JSON.stringify(lines, null, 2));
  const failed = lines.filter((l) => l.level === 'FAIL').length;
  console.log(failed === 0 ? `RESULT ${script}: no failures` : `RESULT ${script}: ${failed} failure(s)`);
  process.exit(failed === 0 ? 0 : 1);
}

export function outPath(file: string): string {
  mkdirSync(outDir, { recursive: true });
  return join(outDir, file);
}
