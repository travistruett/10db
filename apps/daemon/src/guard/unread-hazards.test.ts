import { DEFAULT_HAZARDS } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { fixedPnpmCommand, unreadableHazard } from './unread-hazards';

const deps = DEFAULT_HAZARDS.filter((hazard) => hazard.name === 'deps');

describe('unreadableHazard reads pnpm value flags from the shared flag table', () => {
  it.each([
    // `test` is the reporter's value and $SUB is the subcommand.
    'pnpm --reporter test $SUB x',
    'pnpm --loglevel lint $SUB x',
    'pnpm --registry build $SUB x',
    'pnpm --store-dir test $SUB x',
    // The tag's value may be empty, leaving `test` after `--filter` and $SUB as the subcommand.
    'pnpm --tag --filter test $SUB x',
  ])('asks for %s with the deps hazard unclaimed', (command) => {
    expect(unreadableHazard(command, deps)).not.toBeNull();
  });

  it.each([
    'pnpm --reporter silent test $F',
    'pnpm --loglevel error lint $F',
    'pnpm --filter @10db/daemon test $F',
    'pnpm -r --filter=@10db/daemon lint $F',
    'pnpm --reporter=silent test $F',
    'pnpm --dir apps/daemon exec prettier --check $F',
  ])('reads %s as arguments to a fixed script', (command) => {
    expect(unreadableHazard(command, deps)).toBeNull();
  });
});

describe('fixedPnpmCommand', () => {
  it('reads a listed value flag with its value', () => {
    expect(fixedPnpmCommand(['pnpm', '--reporter', 'silent', 'test', '$F'])).toEqual([
      'pnpm',
      'test',
    ]);
  });

  it('reads a listed boolean flag', () => {
    expect(fixedPnpmCommand(['pnpm', '-r', '--silent', 'lint'])).toEqual(['pnpm', 'lint']);
  });

  it('reads a listed value flag written with an equals sign', () => {
    expect(fixedPnpmCommand(['pnpm', '--filter=@x/y', 'test'])).toEqual(['pnpm', 'test']);
  });

  it.each([
    // nopt may leave the value empty and read the next `-` word as a flag, so the subcommand moves.
    [['pnpm', '--tag', '--filter', 'test', '$SUB', 'x']],
    [['pnpm', '--reporter', '-r', 'test', '$F']],
    [['pnpm', '--filter', '-F', 'test', '$F']],
  ])('returns null when a value flag is followed by a word starting with a dash: %j', (line) => {
    expect(fixedPnpmCommand(line)).toBeNull();
  });

  it.each([
    [['pnpm', '--unknown', 'test', '$F']],
    [['pnpm', '--unknown=x', 'test', '$F']],
    [['pnpm', '-Z', 'test', '$F']],
  ])('returns null on a flag in neither list: %j', (line) => {
    expect(fixedPnpmCommand(line)).toBeNull();
  });
});
