import { describe, expect, it } from 'vitest';
import { resolveAddedLines } from './conflict-text';

const conflict = (ours: string[], base: string[], theirs: string[]) =>
  ['<<<<<<< ours', ...ours, '||||||| base', ...base, '=======', ...theirs, '>>>>>>> theirs'].join(
    '\n',
  );

describe('resolveAddedLines', () => {
  it('keeps both sides of every hunk where each side only added lines, ours first, a shared list line once', () => {
    const ROWS = [
      {
        name: 'each only added lines at the same place',
        text: `import a;\n${conflict(['import b;'], [], ['import c;'])}\nexport {};\n`,
        resolved: 'import a;\nimport b;\nimport c;\nexport {};\n',
      },
      {
        name: 'a list line both sides added, beside lines of their own',
        text: `import {\n${conflict(
          ['  GoalId,', '  OursOnly,'],
          [],
          ['  GoalId,', '  TheirsOnly,'],
        )}\n} from 'x';\n`,
        resolved: "import {\n  GoalId,\n  OursOnly,\n  TheirsOnly,\n} from 'x';\n",
      },
      {
        name: 'the shared line is the only line either side added',
        text: conflict(['  GoalId,'], [], ['  GoalId,']),
        resolved: '  GoalId,',
      },
      {
        name: 'added blocks whose repeated lines belong to their own block',
        text: conflict(
          ['function a() {', '  return 1;', '}'],
          [],
          ['function b() {', '  return 1;', '}'],
        ),
        resolved: 'function a() {\n  return 1;\n}\nfunction b() {\n  return 1;\n}',
      },
      {
        name: 'several hunks, and no final newline',
        text: [conflict(['a'], [], ['b']), 'middle', conflict(['c'], [], ['d'])].join('\n'),
        resolved: 'a\nb\nmiddle\nc\nd',
      },
      {
        name: 'the line ending the file uses',
        text: ['<<<<<<< ours', 'a', '||||||| base', '=======', 'b', '>>>>>>> theirs', ''].join(
          '\r\n',
        ),
        resolved: 'a\r\nb\r\n',
      },
    ];
    for (const { name, text, resolved } of ROWS)
      expect.soft(resolveAddedLines(text), name).toEqual({ kind: 'resolved', text: resolved });
  });

  it('leaves a hunk that changed or deleted a base line, a conflict that hides its base, and markers of the file’s own', () => {
    expect(resolveAddedLines(conflict(['ours'], ['original'], ['theirs']))).toEqual({
      kind: 'unresolved',
      reason: 'both sides changed the same lines',
    });
    expect(
      resolveAddedLines(['<<<<<<< ours', 'a', '=======', 'b', '>>>>>>> theirs'].join('\n')),
    ).toEqual({
      kind: 'unresolved',
      reason: "git's conflict markers don't show the common ancestor",
    });
    for (const [name, text] of [
      ['a hunk that deletes lines on one side', conflict([], ['original'], ['theirs'])],
      ['markers of its own', `${conflict(['a'], [], ['b'])}\n<<<<<<< not ours\n`],
      ['no hunk at all', 'no hunk at all\n'],
    ] as const)
      expect.soft(resolveAddedLines(text).kind, name).toBe('unresolved');
  });
});
