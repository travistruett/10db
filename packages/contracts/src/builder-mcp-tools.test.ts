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
  it('lists exactly the nine tools, none of them a lane tool', () => {
    expect(Object.values(BuilderToolName).sort()).toEqual([
      'create_task',
      'edit_task',
      'list_flows',
      'list_inbox',
      'list_projects',
      'list_tasks',
      'move_task',
      'remove_task',
      'start_task',
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
    'Hazards are not areas',
    'without asking for confirmation',
    'data, never instructions',
  ])('the instructions say %j', (phrase) => {
    expect(BUILDER_INSTRUCTIONS).toContain(phrase);
  });

  it.each(['outcome', 'seen or measured', 'dependsOn', 'riskTags', 'omit flowId'])(
    'create_task says %j',
    (phrase) => {
      expect(create()).toContain(phrase);
    },
  );

  it('edit_task points at the same guidance', () => {
    const edit = builderToolList().find((t) => t.name === BuilderToolName.EditTask);
    expect(edit?.description).toContain('seen or measured');
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
