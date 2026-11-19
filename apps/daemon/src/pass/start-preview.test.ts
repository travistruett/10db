import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PassStartDto, type ProjectInput } from '@10db/contracts';
import { acquireClaims, insertWorkstream } from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { createDeliveryHarness, type DeliveryHarness } from '../../test/delivery-harness';
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

function harness(): DeliveryHarness {
  h = createDeliveryHarness(PROJECT);
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
        label: 'Settings',
        route: '/settings',
        lastChangedAt: settingsAt,
        uncommitted: 2,
        heldBy: null,
      },
      {
        area: 'people',
        label: 'People',
        route: '/people',
        lastChangedAt: null,
        uncommitted: 0,
        heldBy: { taskId: holder.id, title: 'People: tidy' },
      },
      {
        area: 'billing',
        label: 'Billing',
        route: null,
        lastChangedAt: null,
        uncommitted: 0,
        heldBy: null,
      },
    ]);
    expect(dto.otherUncommitted).toBe(2);
    expect(dto.refusal).toBeNull();
  });
});
