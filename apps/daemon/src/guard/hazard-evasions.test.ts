import { DEFAULT_HAZARDS } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { judgeToolUse } from './judge';
import { sandboxedAsk } from './sandboxed-asks';

const CLAIMED = [
  { kind: 'hazard', name: 'deps' },
  { kind: 'hazard', name: 'migrations' },
] as const;

function guard(command: string, claimed: boolean) {
  return judgeToolUse({
    toolName: 'Bash',
    toolInput: { command },
    repoPath: '/tmp/repo',
    areas: [],
    hazards: DEFAULT_HAZARDS,
    claims: claimed ? [...CLAIMED] : [],
    readOnly: false,
    protectedPaths: [],
  });
}
const hook = (command: string, tool = 'Bash') =>
  sandboxedAsk({ toolName: tool, input: { command } }, DEFAULT_HAZARDS);

describe('a hazard spelled around a redirection is still that hazard', () => {
  it.each([
    ['a redirection with an attached target', 'pnpm 2>/dev/null add x'],
    ['a redirection to a file', 'pnpm >/dev/null add x'],
    ['a separate target', 'pnpm > /dev/null add x'],
    ['a migration', 'pnpm 2>/dev/null db:migrate'],
    ['a quoted word that looks like a redirection', "pnpm add '2>/dev/null' x"],
    ['a quoted operator before the subcommand', 'pnpm ">" add x'],
    ['a quoted redirection before the subcommand', "pnpm '2>/dev/null' add x"],
  ])('%s: %s', (_name, command) => {
    expect(guard(command, false).decision).toBe('deny');
    expect(guard(command, true).decision).toBe('allow');
    expect(hook(command)?.decision).toBe('ask');
  });
});

describe('a hazard program with a word 10db cannot read asks', () => {
  it.each([
    'x=add; pnpm $x lodash',
    'p=pnpm; $p add x',
    'pnpm ${X:-add} x',
    'pnpm $((0)) add x',
    'pnpm `echo add` x',
    'echo add x | xargs pnpm',
    'env pnpm $sub x',
    '$CMD --help',
    'for d in a b; do (cd $d && pnpm $verb x); done',
    "sh -c 'pnpm $verb x'",
  ])('%s', (command) => {
    expect(hook(command)?.decision).toBe('ask');
    expect(hook(command, 'Monitor')?.decision).toBe('ask');
  });
});

describe('a wrapper does not hide the program that feeds a hazard its arguments', () => {
  it.each([
    'nice xargs pnpm',
    'timeout 5 xargs pnpm',
    'env xargs pnpm',
    'command xargs pnpm',
    'echo x | parallel pnpm',
    'parallel pnpm ::: add',
  ])('%s', (command) => {
    expect(hook(command)?.decision).toBe('ask');
  });
});

describe('ordinary commands still pass', () => {
  it.each([
    'pnpm --filter @10db/daemon exec vitest run src/x.test.ts',
    'grep -rn "$(pwd)" .',
    'cd "$DIR" && ls',
    'pnpm test 2>&1 | grep foo',
    'echo "$HOME" | wc -l',
    'git status',
    'for f in *.ts; do wc -l $f; done',
    'xargs wc -l < files.txt',
  ])('%s', (command) => {
    expect(hook(command)).toBeNull();
  });
});
