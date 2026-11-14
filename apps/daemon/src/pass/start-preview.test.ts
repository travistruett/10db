import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PassStartDto, type ProjectInput } from '@10db/contracts';
import {
  acquireClaims,
  getTask,
  insertAccount,
  insertBatch,
  insertWorkstream,
  patchProject,
  transitionBatch,
  transitionWorkstream,
} from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { createDeliveryHarness, type DeliveryHarness } from '../../test/delivery-harness';
import { openPass } from '../delivery';
import { passStartPreview, type PassStartDeps } from './start-preview';

// Workbench spec §4.2: what Start Pass shows before a pass opens, read from the folder and the rows.

const PROJECT: Partial<ProjectInput> = {
  areas: [
    { name: 'settings', globs: ['src/settings/**'], role: 'page', route: '/settings' },
    { name: 'people', globs: ['src/people/**'], role: 'page', route: '/people' },
    { name: 'billing', globs: ['src/billing/**'], role: 'page' },
    { name: 'src', globs: ['src/**'], role: 'shared' },
  ],
};

let h: DeliveryHarness;
afterEach(() => {
  h.close();
});

function harness(project: Partial<ProjectInput> = {}): DeliveryHarness {
  h = createDeliveryHarness({ ...PROJECT, ...project });
  return h;
}

/** The preview with no gate that calls Docker: the Docker lack is read by the route's own wiring. */
function preview(): Promise<PassStartDto> {
  const deps: PassStartDeps = {
    db: h.store.db,
    git: h.git,
    gateCallsDocker: () => Promise.resolve(false),
  };
  return passStartPreview(deps, h.project.id).then((dto) => PassStartDto.parse(dto));
}

function write(path: string, content: string): void {
  const file = join(h.repo, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

/** A run of the task in the project's checkout, moved to `RUNNING`. */
function running(taskId: ReturnType<DeliveryHarness['addTask']>['id']) {
  return h.state.write((ctx) => {
    const ws = insertWorkstream(ctx, taskId, {
      first: { model: 'claude-sonnet-5-5', effort: 'medium' },
    });
    for (const to of ['STARTING', 'RUNNING'] as const)
      transitionWorkstream(ctx, ws.id, { to, fence: null });
    return ws;
  });
}

describe('the Start Pass preview', () => {
  it("lists each page with its route, last change, the folder's changed files and its holder, and the rest counted", async () => {
    harness();
    h.commit('src/settings/page.tsx', 'settings\n');
    h.commit('src/shared.ts', 'shared\n');
    const settingsAt = new Date(
      h.git$('log', '-1', '--format=%cI', '--', 'src/settings'),
    ).toISOString();
    write('src/settings/page.tsx', 'changed\n');
    write('src/settings/new.tsx', 'new\n');
    write('src/shared.ts', 'changed\n');
    write('README.md', 'notes\n');
    const holder = h.addTask('People: tidy', { areas: ['people'] });
    h.state.write((ctx) => {
      const ws = insertWorkstream(ctx, holder.id, {
        first: { model: 'claude-sonnet-5-5', effort: 'medium' },
      });
      acquireClaims(ctx, {
        projectId: h.project.id,
        workstreamId: ws.id,
        requests: [{ kind: 'area', name: 'people' }],
        leaseExpiresAt: '2099-01-01T00:00:00.000Z',
      });
    });

    const dto = await preview();

    expect(dto.pages).toEqual([
      {
        area: 'settings',
        route: '/settings',
        lastChangedAt: settingsAt,
        uncommitted: 2,
        heldBy: null,
      },
      {
        area: 'people',
        route: '/people',
        lastChangedAt: null,
        uncommitted: 0,
        heldBy: { taskId: holder.id, title: 'People: tidy' },
      },
      { area: 'billing', route: null, lastChangedAt: null, uncommitted: 0, heldBy: null },
    ]);
    expect(dto.otherUncommitted).toBe(2);
    expect(dto.refusal).toBeNull();
  });

  it("says the folder's branch is ahead of origin's base, and that no app address is set", async () => {
    harness();
    h.commit('src/settings/page.tsx', 'settings\n');
    h.commit('src/settings/more.tsx', 'more\n');

    expect((await preview()).lacks).toEqual([
      { kind: 'ahead_of_base', count: 2, branch: 'main' },
      { kind: 'no_app_url', count: null, branch: null },
      { kind: 'no_changed_check', count: null, branch: null },
    ]);
  });

  it('says nothing is lacking with the branch at the base, an app address and a changed-files check set', async () => {
    harness();
    h.state.write((ctx) =>
      patchProject(ctx, h.project.id, {
        appUrl: 'http://localhost:3000',
        changedCheckCommand: 'make check-changed',
      }),
    );

    expect((await preview()).lacks).toEqual([]);
  });

  it("refuses nothing for a project on a ChatGPT account: a pass runs on the project's own account", async () => {
    harness();
    h.state.write((ctx) => {
      const account = insertAccount(
        ctx,
        { kind: 'codex_signin', label: 'ChatGPT plan' },
        { configDirFor: (id) => join(h.dataDir, 'accounts', id) },
      );
      patchProject(ctx, h.project.id, { accountId: account.id });
    });

    expect((await preview()).refusal).toBeNull();
  });

  it.each<{ name: string; code: string; arrange: () => Promise<void> | void }>([
    {
      name: 'a project with no page area',
      code: 'no_page_area',
      arrange: () => {
        h.state.write((ctx) =>
          patchProject(ctx, h.project.id, { areas: [{ name: 'src', globs: ['src/**'] }] }),
        );
      },
    },
    {
      name: 'a pass already open',
      code: 'pass_open',
      arrange: async () => {
        const task = h.addTask('Settings: tidy', { areas: ['settings'] });
        await openPass(
          h.ctx,
          { projectId: h.project.id, name: 'Polish', taskIds: [task.id] },
          { leaseMs: 60_000, putBack: () => Promise.resolve({ applied: [], left: [] }) },
        );
      },
    },
    {
      name: 'an unfinished batch in Your folder',
      code: 'unfinished_batch',
      arrange: () => {
        h.state.write((ctx) => {
          const batch = insertBatch(ctx, {
            projectId: h.project.id,
            title: 'Earlier',
            baseBranch: 'main',
          });
          transitionBatch(ctx, batch.id, { to: 'OPEN' });
        });
      },
    },
    {
      name: 'a lane running in Your folder',
      code: 'lanes_in_folder',
      arrange: () => {
        running(h.addTask('Tidy the api', { areas: ['src'] }).id);
      },
    },
    {
      name: 'a folder on a 10db branch no task names',
      code: 'return_branch',
      arrange: () => {
        h.git$('switch', '-q', '-c', '10db/stray-abc123');
      },
    },
    {
      name: 'a merge in progress',
      code: 'operation_in_progress',
      arrange: () => {
        h.git$('switch', '-q', '-c', 'other');
        h.commit('src/clash.ts', 'theirs\n');
        h.git$('switch', '-q', 'main');
        h.commit('src/clash.ts', 'ours\n');
        expect(() => h.git$('merge', '--no-edit', 'other')).toThrow();
      },
    },
    {
      name: 'a detached HEAD',
      code: 'detached_head',
      arrange: () => {
        h.git$('switch', '-q', '--detach');
      },
    },
  ])('refuses $name with its reason, as opening would', async ({ arrange, code }) => {
    harness();
    await arrange();

    const { refusal } = await preview();

    expect(refusal?.code).toBe(code);
    expect(refusal?.message).not.toBe('');
  });

  it('names the task of the open pass as the holder of its page', async () => {
    harness();
    const task = h.addTask('Settings: tidy', { areas: ['settings'] });
    await openPass(
      h.ctx,
      { projectId: h.project.id, name: 'Polish', taskIds: [task.id] },
      { leaseMs: 60_000, putBack: () => Promise.resolve({ applied: [], left: [] }) },
    );

    const settings = (await preview()).pages.find((p) => p.area === 'settings');

    expect(settings?.heldBy).toEqual({
      taskId: task.id,
      title: getTask(h.store.db, task.id).title,
    });
  });
});
