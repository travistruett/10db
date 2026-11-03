import { ShapeToolName } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { judgeShapeCall, type ShapeAccess } from './confinement';
import {
  SHAPE_ALLOWED_TOOLS,
  SHAPE_BUILT_IN_TOOLS,
  SHAPE_DISALLOWED_TOOLS,
  SHAPE_OFFERED_TOOLS,
  SHAPE_SYSTEM_PROMPT,
} from './policy';

// Shape spec §5.2: the lists a session starts with, and the one prompt that explains them.

const access: ShapeAccess = {
  checkout: '/nowhere/checkout',
  home: '/nowhere/home',
  protectedReads: [],
  filesDir: '/nowhere/files',
  tempRoot: '/nowhere/tmp',
};

describe('the tool lists of a Shape session', () => {
  it('offers only built-in tools that read, and the Agent tool', () => {
    expect([...SHAPE_BUILT_IN_TOOLS]).toEqual(['Read', 'Grep', 'Glob', 'Agent']);
  });

  it('names every tool that writes or runs a command as disallowed, and offers none of them', () => {
    for (const name of [
      'Edit',
      'Write',
      'NotebookEdit',
      'Bash',
      'Monitor',
      'WebFetch',
      'WebSearch',
    ]) {
      expect(SHAPE_DISALLOWED_TOOLS).toContain(name);
      expect(SHAPE_BUILT_IN_TOOLS).not.toContain(name);
      expect(SHAPE_ALLOWED_TOOLS).not.toContain(name);
    }
  });

  it('approves without a prompt only tools the confinement judge allows the main session', () => {
    for (const tool of SHAPE_OFFERED_TOOLS) {
      expect(SHAPE_ALLOWED_TOOLS).toContain(`mcp__10db__${tool}`);
      expect(
        judgeShapeCall({ toolName: `mcp__10db__${tool}`, toolInput: {} }, access).decision,
      ).toBe('allow');
    }
  });

  it('offers none of the tools whose slice is not built', () => {
    expect([...SHAPE_OFFERED_TOOLS].sort()).toEqual(
      [
        ShapeToolName.NoteHeard,
        ShapeToolName.ProposePlan,
        ShapeToolName.SimilarTasks,
        ShapeToolName.FindRecords,
      ].sort(),
    );
  });
});

describe('remembering and sizing (§5.5, §8)', () => {
  it('tells the session to check records before proposing one and to say when it contradicts one', () => {
    expect(SHAPE_SYSTEM_PROMPT).toMatch(/find_records/);
    expect(SHAPE_SYSTEM_PROMPT).toMatch(/contradicts/);
    expect(SHAPE_SYSTEM_PROMPT).toMatch(/supersedes/);
  });

  it('tells the session to size from similar finished tasks as a basis', () => {
    expect(SHAPE_SYSTEM_PROMPT).toMatch(/similar_tasks/);
    expect(SHAPE_SYSTEM_PROMPT).toMatch(/basis/);
  });
});

describe('the system prompt', () => {
  it('tells the session to make no proposal before Propose, to echo with note_heard and to cite messages', () => {
    expect(SHAPE_SYSTEM_PROMPT).toMatch(/note_heard/);
    expect(SHAPE_SYSTEM_PROMPT).toMatch(/propose_plan/);
    expect(SHAPE_SYSTEM_PROMPT).toMatch(/\[m:/);
    expect(SHAPE_SYSTEM_PROMPT).toMatch(/until the builder presses Propose/);
  });
});
