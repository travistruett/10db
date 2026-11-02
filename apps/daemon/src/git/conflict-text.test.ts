import { describe, expect, it } from 'vitest';
import { resolveAddedLines } from './conflict-text';

const conflict = (ours: string[], base: string[], theirs: string[]) =>
  ['<<<<<<< ours', ...ours, '||||||| base', ...base, '=======', ...theirs, '>>>>>>> theirs'].join(
    '\n',
  );

describe('resolveAddedLines', () => {
  it('keeps both sides when each only added lines at the same place, ours first', () => {
    const text = `import a;\n${conflict(['import b;'], [], ['import c;'])}\nexport {};\n`;
    expect(resolveAddedLines(text)).toEqual({
      kind: 'resolved',
      text: 'import a;\nimport b;\nimport c;\nexport {};\n',
    });
  });

  it('writes a list line both sides added once, and keeps each side’s different lines', () => {
    const text = `import {\n${conflict(
      ['  GoalId,', '  OursOnly,'],
      [],
      ['  GoalId,', '  TheirsOnly,'],
    )}\n} from 'x';\n`;
    expect(resolveAddedLines(text)).toEqual({
      kind: 'resolved',
      text: "import {\n  GoalId,\n  OursOnly,\n  TheirsOnly,\n} from 'x';\n",
    });
  });

  it('writes the shared line once when it is the only line either side added', () => {
    const text = conflict(['  GoalId,'], [], ['  GoalId,']);
    expect(resolveAddedLines(text)).toEqual({ kind: 'resolved', text: '  GoalId,' });
  });

  it('keeps repeated lines of added blocks, whose shared lines belong to their own block', () => {
    const text = conflict(
      ['function a() {', '  return 1;', '}'],
      [],
      ['function b() {', '  return 1;', '}'],
    );
    expect(resolveAddedLines(text)).toEqual({
      kind: 'resolved',
      text: 'function a() {\n  return 1;\n}\nfunction b() {\n  return 1;\n}',
    });
  });

  it('resolves every hunk of a file, and keeps a file with no final newline', () => {
    const text = [conflict(['a'], [], ['b']), 'middle', conflict(['c'], [], ['d'])].join('\n');
    expect(resolveAddedLines(text)).toEqual({ kind: 'resolved', text: 'a\nb\nmiddle\nc\nd' });
  });

  it('keeps the line ending a file uses', () => {
    const text = ['<<<<<<< ours', 'a', '||||||| base', '=======', 'b', '>>>>>>> theirs', ''].join(
      '\r\n',
    );
    expect(resolveAddedLines(text)).toEqual({ kind: 'resolved', text: 'a\r\nb\r\n' });
  });

  it('leaves a hunk where either side changed a line the base had', () => {
    const text = conflict(['ours'], ['original'], ['theirs']);
    expect(resolveAddedLines(text)).toEqual({
      kind: 'unresolved',
      reason: 'both sides changed the same lines',
    });
  });

  it('leaves a file whose hunk deletes lines on one side', () => {
    const text = conflict([], ['original'], ['theirs']);
    expect(resolveAddedLines(text).kind).toBe('unresolved');
  });

  it('refuses a conflict that does not show its base, since it cannot tell an insertion', () => {
    const text = ['<<<<<<< ours', 'a', '=======', 'b', '>>>>>>> theirs'].join('\n');
    expect(resolveAddedLines(text)).toEqual({
      kind: 'unresolved',
      reason: "git's conflict markers don't show the common ancestor",
    });
  });

  it('refuses a file that holds conflict markers of its own', () => {
    const text = `${conflict(['a'], [], ['b'])}\n<<<<<<< not ours\n`;
    expect(resolveAddedLines(text).kind).toBe('unresolved');
    expect(resolveAddedLines('no hunk at all\n').kind).toBe('unresolved');
  });
});
