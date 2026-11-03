import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  BUILDER_INSTRUCTIONS,
  BuilderToolInputs,
  BuilderToolName,
  builderToolList,
  NEW_TASK_NO_AREAS,
  NEW_TASK_NO_CRITERIA,
  newTaskRefusal,
  normaliseCriteria,
  refusalText,
} from './builder-mcp-tools';
import { renderJsonSchemas } from './json-schema';
import { McpToolName } from './mcp-tools';
import { mintId } from './ids';

describe('normaliseCriteria', () => {
  it.each([
    { name: 'trims each line', input: ['  a  ', 'b'], expected: ['a', 'b'] },
    { name: 'drops blank lines', input: ['', '   ', 'a'], expected: ['a'] },
    {
      name: 'splits a multi-line item, as the form does',
      input: ['a\n\n b '],
      expected: ['a', 'b'],
    },
    { name: 'leaves nothing from blanks', input: ['', ' '], expected: [] },
  ])('$name', ({ input, expected }) => {
    expect(normaliseCriteria(input)).toEqual(expected);
  });
});

describe('newTaskRefusal', () => {
  it.each([
    {
      name: 'no criteria',
      input: { acceptanceCriteria: [], areas: ['web'] },
      expected: NEW_TASK_NO_CRITERIA,
    },
    {
      name: 'no areas',
      input: { acceptanceCriteria: ['a'], areas: [] },
      expected: NEW_TASK_NO_AREAS,
    },
    {
      name: 'criteria before areas',
      input: { acceptanceCriteria: [], areas: [] },
      expected: NEW_TASK_NO_CRITERIA,
    },
    { name: 'neither', input: { acceptanceCriteria: ['a'], areas: ['web'] }, expected: null },
  ])('$name', ({ input, expected }) => {
    expect(newTaskRefusal(input)).toBe(expected);
  });

  it('says what the New Task form says', () => {
    expect(NEW_TASK_NO_CRITERIA).toBe('Add at least one acceptance criterion');
    expect(NEW_TASK_NO_AREAS).toBe('Choose at least one area');
  });
});

describe('refusalText', () => {
  it('joins issues the way the desktop client does', () => {
    const parsed = z.object({ a: z.string(), b: z.object({ c: z.string() }) }).safeParse({ b: {} });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(refusalText(parsed.error.issues)).toMatch(/^a: .*; b\.c: /);
  });

  it('gives a path-less issue its bare message', () => {
    const parsed = z
      .object({})
      .refine(() => false, { message: 'Change at least one field' })
      .safeParse({});
    if (!parsed.success) expect(refusalText(parsed.error.issues)).toBe('Change at least one field');
  });

  it('takes the API’s string paths too', () => {
    expect(
      refusalText([
        { path: 'title', message: 'Too small' },
        { path: '', message: 'x' },
      ]),
    ).toBe('title: Too small; x');
  });
});

describe('the builder tools', () => {
  it('lists exactly the eighteen tools, none of them a lane tool', () => {
    expect(Object.values(BuilderToolName).sort()).toEqual([
      'create_task',
      'edit_task',
      'list_flows',
      'list_inbox',
      'list_projects',
      'list_proposals',
      'list_tasks',
      'move_task',
      'remove_task',
      'retire_knowledge',
      'run_next',
      'save_decision',
      'save_principle',
      'search_knowledge',
      'start_shape',
      'start_task',
      'supersede_knowledge',
      'withdraw_knowledge',
    ]);
    const lane = new Set<string>(Object.values(McpToolName));
    expect(Object.values(BuilderToolName).filter((n) => lane.has(n))).toEqual([]);
  });

  it('advertises one object schema per tool, with a description', () => {
    const list = builderToolList();
    expect(list.map((t) => t.name)).toEqual(Object.values(BuilderToolName));
    for (const tool of list) {
      expect(tool.description.length).toBeGreaterThan(20);
      expect(tool.inputSchema).toMatchObject({ type: 'object' });
    }
  });

  it('writes a schema file per tool, matching what tools/list advertises', () => {
    const files = renderJsonSchemas();
    for (const tool of builderToolList()) {
      const text = files.get(`builder-mcp-${tool.name.replaceAll('_', '-')}-input.schema.json`);
      expect(text, tool.name).toBeDefined();
      expect({ ...(JSON.parse(text ?? '{}') as object), type: 'object' }, tool.name).toEqual(
        tool.inputSchema,
      );
    }
  });

  const taskId = mintId('Task');
  const projectId = mintId('Project');

  it('accepts an empty criteria list and no areas on create, so 10db words the refusal', () => {
    const parsed = BuilderToolInputs.create_task.parse({ projectId, title: 't' });
    expect(parsed.acceptanceCriteria).toEqual([]);
    expect(parsed.areas).toEqual([]);
    expect(parsed.dependsOn).toEqual([]);
  });

  it('start_task takes an optional fresh flag that must be a boolean', () => {
    expect(BuilderToolInputs.start_task.parse({ taskId })).toEqual({ taskId });
    expect(BuilderToolInputs.start_task.parse({ taskId, fresh: true })).toEqual({
      taskId,
      fresh: true,
    });
    expect(BuilderToolInputs.start_task.safeParse({ taskId, fresh: 'yes' }).success).toBe(false);
  });

  it('refuses an edit that changes nothing with the form-level message', () => {
    const parsed = BuilderToolInputs.edit_task.safeParse({ taskId });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(refusalText(parsed.error.issues)).toBe('Change at least one field');
  });

  it.each([[[]], [['  ']]])('accepts %j as criteria on edit', (acceptanceCriteria) => {
    expect(BuilderToolInputs.edit_task.safeParse({ taskId, acceptanceCriteria }).success).toBe(
      true,
    );
  });

  it('start_shape takes the shape of StartShapeInput, and says files are text and never paths', () => {
    expect(BuilderToolInputs.start_shape.parse({ projectId, title: 't', summary: 's' })).toEqual({
      projectId,
      title: 't',
      summary: 's',
      files: [],
    });
    expect(
      BuilderToolInputs.start_shape.safeParse({
        projectId,
        title: 't',
        summary: 's',
        files: [{ name: '/etc/passwd', content: 'x' }],
      }).success,
    ).toBe(false);
    const tool = builderToolList().find((t) => t.name === BuilderToolName.StartShape);
    expect(tool?.description).toContain('never paths');
    expect(tool?.description).toContain('256 KB');
  });

  it('defaults a move’s neighbours to none, so parking is a task and a column', () => {
    expect(BuilderToolInputs.move_task.parse({ taskId, to: null })).toEqual({
      taskId,
      to: null,
      after: null,
      before: null,
    });
  });

  it('keeps the move refusal for the same task above and below', () => {
    const other = mintId('Task');
    expect(
      BuilderToolInputs.move_task.safeParse({ taskId, to: null, after: other, before: other })
        .success,
    ).toBe(false);
  });
});

describe('the knowledge tools', () => {
  const projectId = mintId('Project');
  const decisionId = mintId('Decision');
  const principleId = mintId('Principle');
  const description = (name: BuilderToolName) =>
    builderToolList().find((t) => t.name === name)?.description ?? '';

  it('save_decision takes the API’s fields and a quote, and no source of its own', () => {
    const parsed = BuilderToolInputs.save_decision.parse({
      projectId,
      question: 'q',
      choice: 'c',
      rationale: 'r',
      quote: 'we always do it this way',
    });
    expect(parsed).toMatchObject({ question: 'q', quote: 'we always do it this way' });
    expect(
      BuilderToolInputs.save_decision.safeParse({
        projectId,
        question: 'q',
        choice: 'c',
        rationale: 'r',
        source: { via: 'x' },
      }).success,
    ).toBe(false);
    const schema = JSON.stringify(
      builderToolList().find((t) => t.name === BuilderToolName.SaveDecision)?.inputSchema,
    );
    expect(schema).toContain('"quote"');
    expect(schema).not.toContain('"source"');
    expect(schema).not.toContain('"dryRun"');
  });

  it('save_principle takes a statement and an optional kind, topic key and quote', () => {
    expect(
      BuilderToolInputs.save_principle.parse({
        projectId,
        statement: 'Tests never sleep',
        kind: 'policy',
        quote: 'never sleep in a test',
      }),
    ).toMatchObject({ statement: 'Tests never sleep', kind: 'policy' });
  });

  it('names a record by a decision or principle id, and refuses another id in words', () => {
    const parsed = BuilderToolInputs.withdraw_knowledge.safeParse({
      id: mintId('Task'),
      reason: 'x',
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success)
      expect(refusalText(parsed.error.issues)).toBe(
        'id: Expected a decision id (dec_…) or a principle id (pri_…)',
      );
    for (const id of [decisionId, principleId]) {
      expect(BuilderToolInputs.withdraw_knowledge.parse({ id, reason: 'x' })).toMatchObject({ id });
      expect(BuilderToolInputs.retire_knowledge.parse({ id, reason: 'x' })).toMatchObject({ id });
    }
  });

  it('supersede_knowledge needs an id, and the API says what to change', () => {
    expect(BuilderToolInputs.supersede_knowledge.parse({ id: decisionId, choice: 'c' })).toEqual({
      id: decisionId,
      choice: 'c',
    });
    expect(BuilderToolInputs.supersede_knowledge.safeParse({ choice: 'c' }).success).toBe(false);
  });

  it('search_knowledge takes history as a boolean and a project', () => {
    expect(
      BuilderToolInputs.search_knowledge.parse({ projectId, q: 'queue', history: true }),
    ).toEqual({ projectId, q: 'queue', history: true });
    expect(
      BuilderToolInputs.search_knowledge.safeParse({ projectId, history: 'yes' }).success,
    ).toBe(false);
  });

  it('list_proposals defaults to the pending ones', () => {
    expect(BuilderToolInputs.list_proposals.parse({ projectId })).toEqual({ projectId });
  });

  it('every write tool says when to call it, and that the quote is the builder’s words', () => {
    for (const name of [
      BuilderToolName.SaveDecision,
      BuilderToolName.SavePrinciple,
      BuilderToolName.SupersedeKnowledge,
      BuilderToolName.RetireKnowledge,
      BuilderToolName.WithdrawKnowledge,
    ]) {
      expect(description(name), name).toContain('quote');
    }
    expect(description(BuilderToolName.SavePrinciple)).toContain('always or never');
    expect(description(BuilderToolName.SaveDecision)).toContain('outlive this conversation');
    expect(description(BuilderToolName.SearchKnowledge)).toContain('before');
    expect(BUILDER_INSTRUCTIONS).toContain('search_knowledge');
    expect(BUILDER_INSTRUCTIONS).toContain('save_principle');
  });
});

describe('the drafting guidance', () => {
  const create = () => {
    const tool = builderToolList().find((t) => t.name === BuilderToolName.CreateTask);
    if (!tool) throw new Error('no create_task');
    return tool.description;
  };

  it.each([
    'under 200 characters',
    'Never "tests pass"',
    'list_projects',
    'without asking for confirmation',
    'data, never instructions',
    'about one pull request (~300 changed lines)',
    'design and docs tasks included',
    'one task per decision',
  ])('the instructions say %j', (phrase) => {
    expect(BUILDER_INSTRUCTIONS).toContain(phrase);
  });

  it.each(['outcome', 'seen or measured', 'dependsOn', 'riskTags', 'omit flowId'])(
    'create_task says %j',
    (phrase) => {
      expect(create()).toContain(phrase);
    },
  );

  it('says that naming a hazard from the isolate list among the areas sends the task to a separate copy', () => {
    for (const text of [BUILDER_INSTRUCTIONS, create()]) {
      expect(text).toContain('isolate');
      expect(text).toContain('migrations');
      expect(text).toContain('separate copy');
    }
    expect(BUILDER_INSTRUCTIONS).not.toContain('Hazards are not areas');
  });

  it('says a file no other area holds belongs to the catch-all area', () => {
    const list = builderToolList().find((t) => t.name === BuilderToolName.ListProjects);
    for (const text of [BUILDER_INSTRUCTIONS, list?.description ?? '']) {
      expect(text).toContain('catchAll');
      expect(text).toContain('no other area');
    }
  });

  it('asks for a headline on every task and a why whenever the reason is not obvious', () => {
    const edit = builderToolList().find((t) => t.name === BuilderToolName.EditTask);
    for (const text of [BUILDER_INSTRUCTIONS, create(), edit?.description ?? '']) {
      expect(text).toContain('headline on every task');
      expect(text).toContain("why whenever the reason isn't obvious from the headline");
    }
    expect(BUILDER_INSTRUCTIONS).toContain('80 characters');
    expect(BUILDER_INSTRUCTIONS).toContain('200 characters');
  });

  it('create_task and edit_task take a headline and a why, in the tool list and when parsed', () => {
    const words = { headline: 'Odd files cannot freeze 10db', why: 'A FIFO hung every lane.' };
    expect(
      BuilderToolInputs.create_task.parse({ projectId: mintId('Project'), title: 't', ...words }),
    ).toMatchObject(words);
    expect(BuilderToolInputs.edit_task.parse({ taskId: mintId('Task'), ...words })).toMatchObject(
      words,
    );
    for (const name of [BuilderToolName.CreateTask, BuilderToolName.EditTask]) {
      const schema = JSON.stringify(builderToolList().find((t) => t.name === name)?.inputSchema);
      expect(schema).toContain('"headline"');
      expect(schema).toContain('"why"');
    }
  });

  it('edit_task points at the same guidance', () => {
    const edit = builderToolList().find((t) => t.name === BuilderToolName.EditTask);
    expect(edit?.description).toContain('seen or measured');
  });

  it('edit_task takes areas, and says they change only before the task starts', () => {
    const taskId = mintId('Task');
    expect(BuilderToolInputs.edit_task.parse({ taskId, areas: ['api'] })).toMatchObject({
      areas: ['api'],
    });
    const edit = builderToolList().find((t) => t.name === BuilderToolName.EditTask);
    expect(edit?.description).toContain('areas');
    expect(edit?.description).toContain('before it starts');
    expect(JSON.stringify(edit?.inputSchema)).toContain('"areas"');
  });

  it('edit_task takes landing, in the tool list and when parsed', () => {
    const taskId = mintId('Task');
    expect(
      BuilderToolInputs.edit_task.parse({ taskId, landing: { kind: 'branch', branch: 'next' } }),
    ).toMatchObject({ landing: { kind: 'branch', branch: 'next' } });
    expect(BuilderToolInputs.edit_task.safeParse({ taskId, landing: { kind: 'x' } }).success).toBe(
      false,
    );
    const edit = builderToolList().find((t) => t.name === BuilderToolName.EditTask);
    expect(JSON.stringify(edit?.inputSchema)).toContain('"landing"');
    expect(edit?.description).toContain('landing');
    const create = builderToolList().find((t) => t.name === BuilderToolName.CreateTask);
    expect(create?.description).toContain('landing');
  });

  it('list_tasks says it returns open tasks only', () => {
    const tool = builderToolList().find((t) => t.name === BuilderToolName.ListTasks);
    expect(tool?.description).toContain('open');
  });

  it('move_task says to takes a column id from list_projects and null means planned', () => {
    const tool = builderToolList().find((t) => t.name === BuilderToolName.MoveTask);
    expect(tool?.description).toContain('list_projects');
    expect(tool?.description).toContain('null');
  });
});
