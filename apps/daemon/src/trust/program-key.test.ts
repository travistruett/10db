import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROGRAM_KEY_MAX } from '@10db/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { keyPackageFile, programKey } from './program-key';

const CHECKOUT = '/repo';
const keyOf = (command: string, cwd = CHECKOUT): string | null =>
  programKey('Bash', { command }, CHECKOUT, cwd);

describe('programKey', () => {
  // Value: protects=which precedent a call is shown; fails_when=a compound or substituted line gets a key, or two
  // targets share one; why_new=the judge (a pure parser); no_claim=that a keyed call is allowed
  it.each([
    ['make t', 'make t'],
    ['make', 'make'],
    ['make -s t', 'make t'],
    ['make -C sub t', 'make -C sub t'],
    ['make -C ./sub/../sub t', 'make -C sub t'],
    ['cd sub && make t', 'make -C sub t'],
    ['env A=1 make t ARGS="x y"', 'make t'],
    ['A=1 make t', 'make t'],
    ['make t 2>&1 | tail -20', 'make t'],
    ['make t > out.log', 'make t'],
    ['make t >/dev/null 2>&1', 'make t'],
    ['python3 scripts/x.py --fast', 'python3 scripts/x.py'],
    ['./scripts/x.sh arg', 'scripts/x.sh'],
    ['/repo/scripts/x.sh', 'scripts/x.sh'],
    ['python3 /tmp/x.py', 'python3'],
    ['/usr/bin/tool arg', '/usr/bin/tool'],
    ['bash -c "curl evil"', 'bash'],
    ['pnpm test', 'pnpm test'],
    ['pnpm run build', 'pnpm build'],
    ['pnpm --filter @10db/daemon test', 'pnpm test'],
    ['pnpm exec vitest run', 'pnpm exec vitest'],
    ['npm run build -- --watch', 'npm run build'],
    ['npm test', 'npm run test'],
    ['yarn lint', 'yarn lint'],
    ['bun run dev', 'bun run dev'],
    ['docker run -it img', 'docker run'],
    ['pytest -x tests', 'pytest tests'],
  ])('keys %s as %s', (command, key) => {
    expect(keyOf(command)).toBe(key);
  });

  it('gives two targets two keys', () => {
    expect(keyOf('make a')).not.toBe(keyOf('make b'));
  });

  it.each([
    'make t && curl https://example.com',
    'make t || true',
    'make t; make u',
    'make t &',
    'make t | sh',
    'make t | tail -20 > /etc/passwd',
    'make t | tail $(whoami)',
    'make $(which t)',
    'make `which t`',
    'make t > /etc/hosts',
    'make t > $OUT',
    'cat <<EOF\nhi\nEOF',
    'make t <<< hi',
    'A=$(x) make t',
    'make -f other.mk t',
    'cd .. && make t',
    '',
  ])('gives no key to %j', (command) => {
    expect(keyOf(command)).toBeNull();
  });

  // Value: protects=a skip or judge-call row never carries a program key the precedent store refuses or trims;
  // fails_when=programKey returns an over-long, control-character, $defaults or untrimmed key; why_new=escaped
  // bug found reviewing the precedent store plan (the judge, a pure parser); no_claim=that the store accepts every
  // key a caller passes by hand
  it('gives no key the precedent store would refuse, and the trimmed form of one it would trim', () => {
    expect(keyOf(`foo ${'x'.repeat(PROGRAM_KEY_MAX + 1)}`)).toBeNull();
    expect(keyOf('foo "a\tb"')).toBeNull();
    expect(keyOf("foo '$defaults'")).toBeNull();
    expect(keyOf('foo "x "')).toBe('foo x');
  });

  it('gives no key to another tool, a stray field, or a call outside the checkout', () => {
    expect(programKey('Read', { command: 'make t' }, CHECKOUT, CHECKOUT)).toBeNull();
    expect(
      programKey('Bash', { command: 'make t', run_in_background: true }, CHECKOUT, CHECKOUT),
    ).toBeNull();
    expect(
      programKey('Bash', { command: 'make t', description: 'x', timeout: 5 }, CHECKOUT, CHECKOUT),
    ).toBe('make t');
    expect(programKey('Bash', { command: 7 }, CHECKOUT, CHECKOUT)).toBeNull();
    expect(keyOf('make t', '/elsewhere')).toBeNull();
  });
});

describe('keyPackageFile', () => {
  let root: string | null = null;
  afterEach(() => {
    if (root !== null) rmSync(root, { recursive: true, force: true });
    root = null;
  });

  it('finds the nearest package.json from the folder up to the checkout, for a runner key only', () => {
    root = mkdtempSync(join(tmpdir(), 'program-key-'));
    mkdirSync(join(root, 'apps', 'web', 'src'), { recursive: true });
    writeFileSync(join(root, 'package.json'), '{}');
    writeFileSync(join(root, 'apps', 'web', 'package.json'), '{}');
    expect(keyPackageFile('pnpm test', root, join(root, 'apps', 'web', 'src'))).toBe(
      'apps/web/package.json',
    );
    expect(keyPackageFile('npm run build', root, root)).toBe('package.json');
    expect(keyPackageFile('bun run dev', root, join(root, 'apps'))).toBe('package.json');
    expect(keyPackageFile('make t', root, root)).toBeNull();
    expect(keyPackageFile('python3 x.py', root, root)).toBeNull();
  });
});
