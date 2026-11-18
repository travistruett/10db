import { createTestStore, listTasks } from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { seedWorkstream } from '../../test/fixtures';
import { fileTestValueFollowUps, testValueBrief, testValueFollowUp } from './test-value-follow-ups';
import { TestValueVerdict, type TestValueFlag } from './test-value-ask';

const NEW_TEST = {
  file: 'src/parse.test.ts',
  name: 'reads a number again',
  line: 40,
  body: '',
  commit: 'abc123',
  valueCard: 'Value: protects=parse; fails_when=parse breaks',
};
const EXISTING = { file: 'src/parse.test.ts', name: 'reads a number', line: 6 };

const flag = (over: Partial<TestValueFlag> = {}): TestValueFlag => ({
  verdict: TestValueVerdict.DuplicateOf,
  confidence: 0.9,
  test: NEW_TEST,
  existing: EXISTING,
  callId: 'jc_1' as TestValueFlag['callId'],
  ...over,
});

describe('testValueFollowUp', () => {
  it.each([
    [
      'a duplicate',
      flag(),
      'Remove "reads a number again" as a duplicate of "reads a number"',
      'src/parse.test.ts:6',
    ],
    [
      'a fold',
      flag({ verdict: TestValueVerdict.FoldInto }),
      'Fold "reads a number again" into "reads a number"',
      'src/parse.test.ts:6',
    ],
    [
      'a move',
      flag({ verdict: TestValueVerdict.MoveCheaper, existing: null }),
      'Move "reads a number again" to a cheaper level',
      'src/parse.test.ts:40',
    ],
  ])('%s names the new test, the existing one and the level', (_name, f, title, place) => {
    const fields = testValueFollowUp(f);
    expect(fields.title).toBe(title);
    expect(fields.description).toContain('src/parse.test.ts:40');
    expect(fields.description).toContain(place);
    expect(fields.description).toContain('0.90');
    expect(fields.description).toContain('abc123');
    expect(fields.acceptanceCriteria?.length).toBeGreaterThan(0);
  });

  it('keeps a long test name inside a title the task accepts', () => {
    const long = 'x'.repeat(400);
    const fields = testValueFollowUp(flag({ test: { ...NEW_TEST, name: long } }));
    expect(fields.title.length).toBeLessThanOrEqual(200);
  });
});

describe('testValueBrief', () => {
  it('lists each flag for the reviewer, or says nothing for none', () => {
    expect(testValueBrief([])).toBeNull();
    const text = testValueBrief([
      flag(),
      flag({ verdict: TestValueVerdict.MoveCheaper, existing: null }),
    ]);
    expect(text).toContain('Duplicate of');
    expect(text).toContain('src/parse.test.ts:6');
    expect(text).toContain('cheaper level');
    expect(text).toContain('not a finding');
  });
});

describe('fileTestValueFollowUps', () => {
  let close: (() => void) | null = null;
  afterEach(() => {
    close?.();
    close = null;
  });

  function setup() {
    const test = createTestStore();
    close = test.close;
    const seeded = seedWorkstream(test.store);
    const file = (flags: readonly TestValueFlag[]) =>
      test.store.write((ctx) => fileTestValueFollowUps(ctx, seeded.task.id, flags)).value;
    const filed = () =>
      listTasks(test.store.db, seeded.project.id).filter((t) => t.id !== seeded.task.id);
    return { ...test, ...seeded, file, filed };
  }

  it('files one Icebox task per flag, naming the source task', () => {
    const s = setup();
    const made = s.file([flag(), flag({ test: { ...NEW_TEST, name: 'second', line: 50 } })]);
    expect(made).toHaveLength(2);
    const tasks = s.filed();
    expect(tasks.map((t) => t.title).sort()).toEqual([
      'Remove "reads a number again" as a duplicate of "reads a number"',
      'Remove "second" as a duplicate of "reads a number"',
    ]);
    expect(tasks[0]?.description).toContain(s.task.title);
  });

  it('files nothing for no flags, and none again for a test already filed', () => {
    const s = setup();
    expect(s.file([])).toEqual([]);
    s.file([flag()]);
    expect(s.file([flag()])).toEqual([]);
    expect(s.filed()).toHaveLength(1);
  });

  it('files at most ten', () => {
    const s = setup();
    const many = Array.from({ length: 14 }, (_, i) =>
      flag({ test: { ...NEW_TEST, name: `case ${String(i)}`, line: 100 + i } }),
    );
    expect(s.file(many)).toHaveLength(10);
  });
});
