import { describe, expect, it } from 'vitest';
import { checkBriefRules, parseBrief } from './brief';

const VALID = `---
title: Real areas
objective: 10db proposes a project's areas from its repository.
cares_most: Areas a non-engineer can read.
criteria:
  - text: A new project gets proposed areas
    check: task
    task: propose-project-areas
  - text: The builder accepts the area names
    check: accept
tasks:
  - key: task-patch-route
    title: Patch a task's areas and dependencies
    areas: [repo]
    criteria: [PATCH /tasks/:id changes areas]
  - key: drawer-editor
    title: Edit areas in the task drawer
    areas: [repo]
    depends_on: [task-patch-route]
  - key: propose-project-areas
    title: Propose a new project's areas
    areas: [repo]
---

Notes below the front matter.
`;

function parsed(text: string) {
  const result = parseBrief(text);
  if (!result.ok) throw new Error(`expected a brief, got ${JSON.stringify(result.errors)}`);
  return result;
}

function refused(text: string) {
  const result = parseBrief(text);
  if (result.ok) throw new Error('expected a refusal');
  return result.errors;
}

describe('parseBrief', () => {
  it('splits the front matter from the notes and validates the brief', () => {
    const { brief, notes } = parsed(VALID);
    expect(brief.title).toBe('Real areas');
    expect(brief.tasks.map((t) => t.key)).toEqual([
      'task-patch-route',
      'drawer-editor',
      'propose-project-areas',
    ]);
    expect(brief.tasks[1]?.depends_on).toEqual(['task-patch-route']);
    expect(notes).toBe('Notes below the front matter.');
  });

  it('reads a brief with Windows line endings and a byte order mark the same way', () => {
    const byteOrderMark = String.fromCodePoint(0xfeff);
    const { brief, notes } = parsed(byteOrderMark + VALID.replaceAll('\n', '\r\n'));
    expect(brief.tasks).toHaveLength(3);
    expect(notes).toBe('Notes below the front matter.');
  });

  it('accepts a brief with no notes', () => {
    const { notes } = parsed(VALID.slice(0, VALID.indexOf('\nNotes')));
    expect(notes).toBe('');
  });

  it('refuses text with no front matter', () => {
    expect(refused('# A plan\n\nJust prose.')).toEqual([
      {
        path: 'Front matter',
        message: 'The brief must start with a --- line, then YAML, then a closing --- line',
      },
    ]);
  });

  it('refuses front matter that never closes', () => {
    expect(refused('---\ntitle: x\n')).toEqual([
      { path: 'Front matter', message: 'The front matter has no closing --- line' },
    ]);
  });

  it('refuses YAML that does not parse, saying where', () => {
    const errors = refused('---\ntitle: [unclosed\nobjective: x\n---\n');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.path).toMatch(/^Front matter, line \d+$/);
  });

  it('lists every shape error with where it is in plain words', () => {
    const errors = refused(`---
title: Real areas
objective: ""
tasks:
  - key: Bad Key
    title: One
    areas: []
  - key: two
    title: Two
    areas: [repo]
    depends_on: [Not A Key]
---
`);
    expect(errors.map((e) => e.path)).toEqual([
      'Objective',
      'Task 1, key',
      'Task 1, areas',
      'Task 2, depends on, item 1',
    ]);
    expect(errors.find((e) => e.path === 'Task 1, key')?.message).toContain('lowercase');
    expect(errors.find((e) => e.path === 'Task 2, depends on, item 1')?.message).toContain(
      'lowercase',
    );
  });

  it("takes a task's optional headline and why, empty when absent", () => {
    const { brief } = parsed(
      VALID.replace(
        "    title: Patch a task's areas and dependencies\n",
        "    title: Patch a task's areas and dependencies\n    headline: Change a task's areas\n    why: Areas were fixed once a task was made.\n",
      ),
    );
    expect(brief.tasks[0]).toMatchObject({
      headline: "Change a task's areas",
      why: 'Areas were fixed once a task was made.',
    });
    expect(brief.tasks[1]).toMatchObject({ headline: '', why: '' });
  });

  it('refuses a headline over 80 characters and a why with a newline, naming each', () => {
    const errors = refused(
      VALID.replace(
        "    title: Patch a task's areas and dependencies\n",
        `    title: Patch a task's areas and dependencies\n    headline: ${'x'.repeat(81)}\n    why: "two\\nlines"\n`,
      ),
    );
    expect(errors.map((e) => e.path)).toEqual(['Task 1, headline', 'Task 1, why']);
    expect(errors[0]?.message).toMatch(/headline is at most 80/);
    expect(errors[1]?.message).toMatch(/why is one line/);
  });

  it('names a criterion by its position', () => {
    const errors = refused(`---
title: T
objective: O
criteria:
  - text: Needs a task
    check: task
tasks:
  - key: a
    title: A
    areas: [repo]
---
`);
    expect(errors.map((e) => e.path)).toEqual(['Criterion 1, task']);
  });
});

const PROJECT = { areaNames: ['repo', 'docs'], people: [{ handle: 'me', name: 'Travis' }] };

function brief(text: string) {
  return parsed(text).brief;
}

describe('checkBriefRules', () => {
  it('passes a valid brief', () => {
    expect(checkBriefRules(brief(VALID), PROJECT)).toEqual([]);
  });

  it('refuses a repeated task key', () => {
    const errors = checkBriefRules(
      brief(`---
title: T
objective: O
tasks:
  - { key: a, title: A, areas: [repo] }
  - { key: a, title: B, areas: [repo] }
---
`),
      PROJECT,
    );
    expect(errors).toEqual([
      { path: 'Task 2, key', message: 'another task already has the key a' },
    ]);
  });

  it('refuses a depends_on key no task has, and a criterion task no task has', () => {
    const errors = checkBriefRules(
      brief(`---
title: T
objective: O
criteria:
  - { text: C, check: merged, task: ghost }
tasks:
  - { key: a, title: A, areas: [repo], depends_on: [drawer-editr] }
---
`),
      PROJECT,
    );
    expect(errors).toEqual([
      { path: 'Task 1, depends on', message: 'no task has the key drawer-editr' },
      { path: 'Criterion 1, task', message: 'no task has the key ghost' },
    ]);
  });

  it('refuses a dependency cycle, naming the tasks in it', () => {
    const errors = checkBriefRules(
      brief(`---
title: T
objective: O
tasks:
  - { key: a, title: A, areas: [repo], depends_on: [c] }
  - { key: b, title: B, areas: [repo], depends_on: [a] }
  - { key: c, title: C, areas: [repo], depends_on: [b] }
  - { key: d, title: D, areas: [repo], depends_on: [d] }
---
`),
      PROJECT,
    );
    expect(errors).toEqual([
      { path: 'Task 1, depends on', message: 'these tasks wait on each other: a, c, b, a' },
      { path: 'Task 4, depends on', message: 'a task cannot depend on itself' },
    ]);
  });

  it('refuses an area the project does not have, listing the ones it has', () => {
    const errors = checkBriefRules(
      brief(`---
title: T
objective: O
tasks:
  - { key: a, title: A, areas: [repo, billing] }
---
`),
      PROJECT,
    );
    expect(errors).toEqual([
      { path: 'Task 1, areas', message: 'the project has no area billing (it has repo, docs)' },
    ]);
  });

  it('refuses an accepting person nobody is called, by handle or by name', () => {
    const text = (person: string) => `---
title: T
objective: O
criteria:
  - { text: C, check: accept, person: ${person} }
tasks:
  - { key: a, title: A, areas: [repo] }
---
`;
    expect(checkBriefRules(brief(text('Travis')), PROJECT)).toEqual([]);
    expect(checkBriefRules(brief(text('me')), PROJECT)).toEqual([]);
    expect(checkBriefRules(brief(text('Mark')), PROJECT)).toEqual([
      { path: 'Criterion 1, person', message: 'nobody is called Mark' },
    ]);
  });

  it('refuses a person name more than one person shares, unless a handle matches', () => {
    const text = (person: string) => `---
title: T
objective: O
criteria:
  - { text: C, check: accept, person: ${person} }
tasks:
  - { key: a, title: A, areas: [repo] }
---
`;
    const project = {
      areaNames: ['repo'],
      people: [
        { handle: 'sam1', name: 'Sam' },
        { handle: 'sam2', name: 'Sam' },
        { handle: 'Sam', name: 'Samuel' },
      ],
    };
    expect(checkBriefRules(brief(text('Sam')), project)).toEqual([]);
    expect(checkBriefRules(brief(text('sam1')), project)).toEqual([]);
    expect(
      checkBriefRules(brief(text('Sam')), {
        areaNames: ['repo'],
        people: project.people.slice(0, 2),
      }),
    ).toEqual([
      {
        path: 'Criterion 1, person',
        message: 'more than one person is called Sam; name them by handle instead',
      },
    ]);
  });

  it('reports an unknown depends_on, a cycle and an unknown area together', () => {
    const errors = checkBriefRules(
      brief(`---
title: T
objective: O
tasks:
  - { key: a, title: A, areas: [repo], depends_on: [b, nope] }
  - { key: b, title: B, areas: [mystery], depends_on: [a] }
---
`),
      PROJECT,
    );
    expect(errors.map((e) => e.path).sort()).toEqual([
      'Task 1, depends on',
      'Task 1, depends on',
      'Task 2, areas',
    ]);
  });
});
