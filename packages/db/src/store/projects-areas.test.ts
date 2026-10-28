import { ConflictError, InvalidError, ProjectPatch, type ProjectId } from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireClaims } from './claims';
import { getProject, patchProject } from './projects';
import type { Store } from './store';
import { insertTask } from './tasks';
import { createTestStore, seedProject } from './test-support';
import { insertWorkstream } from './workstreams';

let store: Store;
let close: () => void;
beforeEach(() => {
  ({ store, close } = createTestStore());
});
afterEach(() => {
  close();
});

function holdArea(projectId: ProjectId, area: string, title: string) {
  const task = store.write((ctx) =>
    insertTask(ctx, projectId, { title, acceptanceCriteria: ['x'], areas: [area] }),
  ).value;
  const ws = store.write((ctx) => insertWorkstream(ctx, task.id)).value;
  store.write((ctx) =>
    acquireClaims(ctx, {
      projectId,
      workstreamId: ws.id,
      requests: [{ kind: 'area', name: area }],
      leaseExpiresAt: '2099-01-01T00:00:00.000Z',
    }),
  );
}

describe('patching areas and hazards', () => {
  it('replaces both lists on the same project row', () => {
    const project = seedProject(store);
    const areas = [{ name: 'core', globs: ['src/core/**'] }];
    const hazards = [{ name: 'lockfile', globs: ['pnpm-lock.yaml'], commands: ['pnpm add'] }];
    const patched = store.write((ctx) => patchProject(ctx, project.id, { areas, hazards })).value;
    expect(patched).toMatchObject({ id: project.id, areas, hazards });
    expect(getProject(store.db, project.id)).toMatchObject({ areas, hazards });
  });

  it.each([
    ['an absolute path', '/etc/**'],
    ['a parent folder', '../outside/**'],
    ['an unclosed bracket', 'src/[a-/**'],
    ['an unclosed brace', 'src/{a,b/**'],
    ['a backslash', 'src\\api\\**'],
  ])('refuses %s as a path pattern', (_name, glob) => {
    expect(ProjectPatch.safeParse({ areas: [{ name: 'core', globs: [glob] }] }).success).toBe(
      false,
    );
    expect(
      ProjectPatch.safeParse({ hazards: [{ name: 'h', globs: [glob], commands: [] }] }).success,
    ).toBe(false);
  });

  it('refuses a name used twice, in areas or across areas and hazards', () => {
    const project = seedProject(store);
    const dup = { name: 'a', globs: ['a/**'] };
    expect(() =>
      store.write((ctx) => patchProject(ctx, project.id, { areas: [dup, dup] })),
    ).toThrow();
    expect(() =>
      store.write((ctx) =>
        patchProject(ctx, project.id, { areas: [dup], hazards: [{ ...dup, commands: [] }] }),
      ),
    ).toThrow(/used twice/);
    // An area patched alone still can't take the name of a hazard the project already has.
    expect(() =>
      store.write((ctx) =>
        patchProject(ctx, project.id, { areas: [{ name: 'deps', globs: ['deps/**'] }] }),
      ),
    ).toThrow(InvalidError);
  });

  it('refuses to remove or rename an area a running task holds, naming the task', () => {
    const project = seedProject(store);
    holdArea(project.id, 'api', 'Fix the login bug');
    const ui = { name: 'ui', globs: ['src/ui/**'] };
    const removal = () => store.write((ctx) => patchProject(ctx, project.id, { areas: [ui] }));
    expect(removal).toThrow(ConflictError);
    expect(removal).toThrow(/api.*Fix the login bug/);
    expect(() =>
      store.write((ctx) =>
        patchProject(ctx, project.id, { areas: [ui, { name: 'web', globs: ['src/api/**'] }] }),
      ),
    ).toThrow(/Fix the login bug/);
    expect(getProject(store.db, project.id).areas.map((a) => a.name)).toEqual(['api', 'ui']);
  });

  it('lets a held area change its paths', () => {
    const project = seedProject(store);
    holdArea(project.id, 'api', 'Fix the login bug');
    const areas = [{ name: 'api', globs: ['src/server/**'] }];
    expect(store.write((ctx) => patchProject(ctx, project.id, { areas })).value.areas).toEqual(
      areas,
    );
  });
});
