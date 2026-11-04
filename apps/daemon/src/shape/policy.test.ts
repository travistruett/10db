import { ShapeToolName } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { judgeShapeCall, type ShapeAccess } from './confinement';
import {
  rehearseNote,
  SHAPE_AGENTS,
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

  it('offers every tool but report_finding to the session, and report_finding only to reviewers', () => {
    expect([...SHAPE_OFFERED_TOOLS].sort()).toEqual(
      [
        ShapeToolName.NoteHeard,
        ShapeToolName.ProposePlan,
        ShapeToolName.Attach,
        ShapeToolName.SimilarTasks,
        ShapeToolName.FindRecords,
        ShapeToolName.WriteSpec,
        ShapeToolName.ResolveFinding,
      ].sort(),
    );
    expect(SHAPE_OFFERED_TOOLS).not.toContain(ShapeToolName.ReportFinding);
    expect(SHAPE_ALLOWED_TOOLS).toContain('mcp__10db__report_finding');
  });
});

describe('the reviewers (§7)', () => {
  it('are scope, engineering and rehearsal, each with exactly Read, Grep, Glob and report_finding', () => {
    expect(Object.keys(SHAPE_AGENTS).sort()).toEqual(['engineering', 'rehearsal', 'scope']);
    for (const agent of Object.values(SHAPE_AGENTS))
      expect([...agent.tools]).toEqual(['Read', 'Grep', 'Glob', 'mcp__10db__report_finding']);
  });

  it('can each be launched by the session and are the only agents it may launch', () => {
    for (const name of Object.keys(SHAPE_AGENTS))
      expect(
        judgeShapeCall(
          { toolName: 'Agent', toolInput: { subagent_type: name, prompt: 'x' } },
          access,
        ).decision,
      ).toBe('allow');
  });

  it('are told to report through report_finding and what the closing report is', () => {
    expect(SHAPE_AGENTS.rehearsal.prompt).toMatch(/final: true/);
    expect(SHAPE_AGENTS.rehearsal.prompt).toMatch(/kind: "none"/);
    expect(SHAPE_AGENTS.scope.prompt).toMatch(/findingId/);
  });

  it('the session is told the ceremony rule, the spec flow and the rehearsal', () => {
    expect(SHAPE_SYSTEM_PROMPT).toMatch(/write_spec/);
    expect(SHAPE_SYSTEM_PROMPT).toMatch(/resolve_finding/);
    expect(SHAPE_SYSTEM_PROMPT).toMatch(/subagent_type "rehearsal"/);
  });

  it('the session is told to plan landings, one per goal by default, and that tasks in one share a pull request', () => {
    expect(SHAPE_SYSTEM_PROMPT).toMatch(/landings/);
    expect(SHAPE_SYSTEM_PROMPT).toMatch(/one per goal/);
    expect(SHAPE_SYSTEM_PROMPT).toMatch(/same place and land the same way/);
  });
});

describe('the rehearsal turn', () => {
  it('lists each task with the hash it was read at and asks for one Agent call per task', () => {
    const { note, instruction } = rehearseNote([
      { effortKey: 'density', taskKey: 'cards', hash: 'abc123', text: 'Title: Cards\nAreas: ui' },
    ]);
    expect(note).toBe('Rehearsing 1 task');
    expect(instruction).toContain('effortKey density · taskKey cards · taskHash abc123');
    expect(instruction).toContain('  Title: Cards\n  Areas: ui');
    expect(instruction).toMatch(/one Agent call per task/);
  });
});

describe('remembering and sizing (§5.5, §8)', () => {
  it('tells the session to check records before proposing one and to say when it contradicts one', () => {
    expect(SHAPE_SYSTEM_PROMPT).toMatch(/find_records/);
    expect(SHAPE_SYSTEM_PROMPT).toMatch(/contradicts/);
    expect(SHAPE_SYSTEM_PROMPT).toMatch(/supersedes/);
  });

  it('tells the session to propose a principle when the builder states a rule with always or never, after looking for one', () => {
    expect(SHAPE_SYSTEM_PROMPT).toMatch(/always" or "never"/);
    expect(SHAPE_SYSTEM_PROMPT).toMatch(/principle record/);
    expect(SHAPE_SYSTEM_PROMPT).toMatch(/call find_records first/);
    expect(SHAPE_SYSTEM_PROMPT).toMatch(/topicKey/);
  });

  it('tells the session to set about on a question, so Convert stores it under its goal or task', () => {
    expect(SHAPE_SYSTEM_PROMPT).toMatch(/question/);
    expect(SHAPE_SYSTEM_PROMPT).toMatch(/set about to the key of the goal or task/);
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
