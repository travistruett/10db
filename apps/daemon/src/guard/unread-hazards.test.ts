import { DEFAULT_HAZARDS } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { fixedPnpmCommand, unreadableHazard } from './unread-hazards';

const deps = DEFAULT_HAZARDS.filter((hazard) => hazard.name === 'deps');

describe('unreadableHazard reads pnpm value flags from the shared flag table', () => {
  it('asks with the deps hazard unclaimed when a value flag may leave $SUB as the subcommand', () => {
    for (const command of [
      // `test` is the reporter's value and $SUB is the subcommand.
      'pnpm --reporter test $SUB x',
      'pnpm --loglevel lint $SUB x',
      'pnpm --registry build $SUB x',
      'pnpm --store-dir test $SUB x',
      // The tag's value may be empty, leaving `test` after `--filter` and $SUB as the subcommand.
      'pnpm --tag --filter test $SUB x',
    ]) {
      expect.soft(unreadableHazard(command, deps), command).not.toBeNull();
    }
  });

  it('reads a word after a fixed script as an argument', () => {
    for (const command of [
      'pnpm --reporter silent test $F',
      'pnpm --loglevel error lint $F',
      'pnpm --filter @10db/daemon test $F',
      'pnpm -r --filter=@10db/daemon lint $F',
      'pnpm --reporter=silent test $F',
      'pnpm --dir apps/daemon exec prettier --check $F',
    ]) {
      expect.soft(unreadableHazard(command, deps), command).toBeNull();
    }
  });
});

describe('fixedPnpmCommand', () => {
  it('reads listed value and boolean flags, with or without an equals sign', () => {
    expect(fixedPnpmCommand(['pnpm', '--reporter', 'silent', 'test', '$F'])).toEqual([
      'pnpm',
      'test',
    ]);
    expect(fixedPnpmCommand(['pnpm', '-r', '--silent', 'lint'])).toEqual(['pnpm', 'lint']);
    expect(fixedPnpmCommand(['pnpm', '--filter=@x/y', 'test'])).toEqual(['pnpm', 'test']);
  });

  it('returns null when a value flag meets a dash word or a flag is in neither list', () => {
    for (const line of [
      // nopt may leave the value empty and read the next `-` word as a flag, so the subcommand moves.
      ['pnpm', '--tag', '--filter', 'test', '$SUB', 'x'],
      ['pnpm', '--reporter', '-r', 'test', '$F'],
      ['pnpm', '--filter', '-F', 'test', '$F'],
      // A flag in neither list.
      ['pnpm', '--unknown', 'test', '$F'],
      ['pnpm', '--unknown=x', 'test', '$F'],
      ['pnpm', '-Z', 'test', '$F'],
    ]) {
      expect.soft(fixedPnpmCommand(line), line.join(' ')).toBeNull();
    }
  });
});
