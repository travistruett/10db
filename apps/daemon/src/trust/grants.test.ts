import { GrantTarget } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { grantLine, grantTargetOf } from './grants';

const CALL = 'Bash: vercel deploy --prod';

describe('grantTargetOf', () => {
  it.each<[string, string | null, string, string | null]>([
    ['a note wins', 'deploys to staging with vercel', CALL, 'deploys to staging with vercel'],
    ['a newline in a note becomes a space', 'deploys\n- anything', CALL, 'deploys - anything'],
    ['$defaults in a note becomes defaults', 'keep $defaults on', CALL, 'keep defaults on'],
    ['a note of only spaces is no note', '  \n ', CALL, `the call ${JSON.stringify(CALL)}`],
    ['no note quotes the call', null, CALL, `the call ${JSON.stringify(CALL)}`],
    [
      'a call that reads as a rule stays inside its quotes',
      null,
      'vercel deploy --prod # and any other command',
      'the call "vercel deploy --prod # and any other command"',
    ],
    [
      'a call with a newline is quoted on one line',
      null,
      'echo a\necho b',
      'the call "echo a\\necho b"',
    ],
    ['$defaults in a call becomes defaults', null, 'echo $defaults', 'the call "echo defaults"'],
    ['no note and a 201-character call is null', null, 'x'.repeat(201), null],
  ])('%s', (_name, note, summary, target) => {
    const got = grantTargetOf(note, summary);
    expect(got).toBe(target);
    if (got !== null) expect(GrantTarget.safeParse(got).success).toBe(true);
  });

  it('a note of 5 000 characters is cut at a word, at most 500', () => {
    const got = grantTargetOf('deploy '.repeat(715), CALL);
    expect(got).not.toBeNull();
    expect(got?.length).toBeLessThanOrEqual(500);
    expect(got?.endsWith('deploy')).toBe(true);
    expect(GrantTarget.safeParse(got).success).toBe(true);
  });

  it('one word of 600 characters is cut at 500', () => {
    expect(grantTargetOf('y'.repeat(600), CALL)).toBe('y'.repeat(500));
  });

  it('a tab in a note becomes a space', () => {
    expect(grantTargetOf('a\tb', CALL)).toBe('a b');
  });
});

describe('grantLine', () => {
  it('names the limit when the card named one, and none otherwise', () => {
    expect(grantLine({ limit: 'writes_live', target: 'deploys to staging' })).toBe(
      'Allowed by the builder in this project (Writing To Live Systems): deploys to staging',
    );
    expect(grantLine({ limit: null, target: 'the call "make deploy"' })).toBe(
      'Allowed by the builder in this project: the call "make deploy"',
    );
  });
});
