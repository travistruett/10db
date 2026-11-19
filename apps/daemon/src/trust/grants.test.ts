import { GrantTarget } from '@10db/contracts';
import { createTestStore, insertTrustGrant, seedProject } from '@10db/db';
import { describe, expect, it } from 'vitest';
import {
  grantCallSummary,
  grantLine,
  grantTargetOf,
  grantedCallOf,
  isGrantedCall,
  projectGrantLines,
  projectGrantedCalls,
} from './grants';

const CALL = 'Bash: vercel deploy --prod';

describe('grantTargetOf', () => {
  it('is the note on one line, or the call quoted, and never a rewritten or overlong call', () => {
    const rows: [string, string | null, string, string | null][] = [
      ['a note wins', 'deploys to staging with vercel', CALL, 'deploys to staging with vercel'],
      ['a newline in a note becomes a space', 'deploys\n- anything', CALL, 'deploys - anything'],
      ['a tab in a note becomes a space', 'a\tb', CALL, 'a b'],
      ['$defaults in a note becomes defaults', 'keep $defaults on', CALL, 'keep defaults on'],
      ['a note of only spaces is no note', '  \n ', CALL, `the Bash call ${JSON.stringify(CALL)}`],
      ['no note quotes the call', null, CALL, `the Bash call ${JSON.stringify(CALL)}`],
      [
        'a call that reads as a rule stays inside its quotes',
        null,
        'vercel deploy --prod # and any other command',
        'the Bash call "vercel deploy --prod # and any other command"',
      ],
      [
        'a call with a newline is quoted on one line',
        null,
        'echo a\necho b',
        'the Bash call "echo a\\necho b"',
      ],
      [
        'a call holding $defaults needs a note, and is never rewritten',
        null,
        'echo $defaults',
        null,
      ],
      [
        'a format character outside the BMP is escaped whole',
        null,
        'echo \u{E0001}x',
        'the Bash call "echo \\udb40\\udc01x"',
      ],
      ['no note and a 201-character call is null', null, 'x'.repeat(201), null],
      ['one word of 600 characters is cut at 500', 'y'.repeat(600), CALL, 'y'.repeat(500)],
    ];
    for (const [name, note, summary, target] of rows) {
      const got = grantTargetOf(note, summary, 'Bash');
      expect.soft(got, name).toBe(target);
      if (got !== null) expect.soft(GrantTarget.safeParse(got).success, name).toBe(true);
    }
    // A note of 5 000 characters is cut at a word, at most 500.
    const long = grantTargetOf('deploy '.repeat(715), CALL, 'Bash');
    expect.soft(long, 'a 5 000-character note').not.toBeNull();
    expect.soft(long?.length, 'a 5 000-character note').toBeLessThanOrEqual(500);
    expect.soft(long?.endsWith('deploy'), 'a 5 000-character note').toBe(true);
    expect.soft(GrantTarget.safeParse(long).success, 'a 5 000-character note').toBe(true);
  });
});

describe('grantLine', () => {
  it('names the limit when the card named one, and none otherwise', () => {
    expect(grantLine({ limit: 'writes_live', target: 'deploys to staging' })).toBe(
      'Allowed by the builder in this project (Writing To Live Systems): deploys to staging',
    );
    expect(grantLine({ limit: null, target: 'the Bash call "make deploy"' })).toBe(
      'Allowed by the builder in this project: the Bash call "make deploy"',
    );
  });
});

describe('a quoted call is a grant of its tool', () => {
  const PATH = '/Users/b/app/scripts/release.sh';

  it('round-trips a format character outside the BMP to the same call, and refuses a tool name agents never use', () => {
    const call = 'echo \u{E0001}x';
    const target = grantTargetOf(null, call, 'Bash');
    expect(grantedCallOf(target ?? '')).toEqual({ tool: 'Bash', call });
    expect(grantTargetOf(null, 'x', 'Bash" call "x')).toBeNull();
  });

  it('an Edit grant covers only an Edit of the same input', () => {
    const { store, close } = createTestStore();
    try {
      const project = seedProject(store);
      store.write((ctx) =>
        insertTrustGrant(ctx, {
          projectId: project.id,
          limit: 'writes_live',
          target: grantTargetOf(null, grantCallSummary('Edit', { file_path: PATH }), 'Edit') ?? '',
          sourceInboxId: null,
        }),
      );
      const granted = projectGrantedCalls(store.db, project.id);
      const rows: [string, { tool: string; input: Record<string, unknown> }, boolean][] = [
        ['the same tool and call', { tool: 'Edit', input: { file_path: PATH } }, true],
        ['a Bash command that is the file', { tool: 'Bash', input: { command: PATH } }, false],
        ['a Write of the same input', { tool: 'Write', input: { file_path: PATH } }, false],
        ['a MultiEdit of the same input', { tool: 'MultiEdit', input: { file_path: PATH } }, false],
      ];
      for (const [name, call, covered] of rows) {
        expect.soft(isGrantedCall(granted, call.tool, call.input), name).toBe(covered);
      }
    } finally {
      close();
    }
  });

  it('a Bash grant covers no Edit or Write of the file it names', () => {
    const { store, close } = createTestStore();
    try {
      const project = seedProject(store);
      store.write((ctx) =>
        insertTrustGrant(ctx, {
          projectId: project.id,
          limit: null,
          target: grantTargetOf(null, PATH, 'Bash') ?? '',
          sourceInboxId: null,
        }),
      );
      const granted = projectGrantedCalls(store.db, project.id);
      expect(isGrantedCall(granted, 'Bash', { command: PATH })).toBe(true);
      for (const tool of ['Edit', 'Write'])
        expect(isGrantedCall(granted, tool, { file_path: PATH })).toBe(false);
    } finally {
      close();
    }
  });

  it('a quoted call stored with no tool matches nothing and is no line for a judge', () => {
    const { store, close } = createTestStore();
    try {
      const project = seedProject(store);
      store.write((ctx) =>
        insertTrustGrant(ctx, {
          projectId: project.id,
          limit: null,
          target: 'the call "pnpm test"',
          sourceInboxId: null,
        }),
      );
      expect(
        isGrantedCall(projectGrantedCalls(store.db, project.id), 'Bash', { command: 'pnpm test' }),
      ).toBe(false);
      expect(projectGrantLines(store.db, project.id)).toEqual([]);
    } finally {
      close();
    }
  });
});
