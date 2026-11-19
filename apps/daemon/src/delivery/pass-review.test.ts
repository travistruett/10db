import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  mintId,
  PassNoticeKind,
  Rigor,
  TaskMessageAuthor,
  WHOLE_PROJECT_PAGE,
  type AreaDef,
  type Finding,
  type PassId,
  type ProjectInput,
  type TaskDto,
} from '@10db/contracts';
import { getPassProgress, listTaskThread, offeredText, patchProject } from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { createDeliveryHarness, type DeliveryHarness } from '../../test/delivery-harness';
import { tempDir } from '../../test/fixtures';
import type { AgentAdapter } from '../sessions';
import { openPass, type PutBackKeptWork } from './index';
import { findingTargets, reviewPassTip, type PassReviewDeps } from './pass-review';

// Workbench spec §8.3, D19, D21: the one review of a pass's pull request reads its diff once, and
// each finding is offered to the page whose file it names, else in the pass's header; nothing is
// sent to an agent by itself, and an unchanged tip is not reviewed again.

const AREAS: AreaDef[] = [
  { name: 'settings', globs: ['src/settings/**'], role: 'page', route: '/settings' },
  { name: 'people', globs: ['src/people/**'], role: 'page', route: '/people' },
  { name: 'shared', globs: ['src/lib/**'], role: 'shared' },
];

const finding = (location: string | null): Finding => ({
  severity: 'MAJOR',
  location,
  text: `MAJOR ${location ?? ''} wrong`,
});

describe('findingTargets', () => {
  const settings = mintId('Task');
  const people = mintId('Task');
  const pages = [
    { taskId: settings, areas: ['settings'] },
    { taskId: people, areas: ['people'] },
  ];

  it('sends a finding to the page whose area holds its file, else to the header, and every file finding of a pass of one to its one page', () => {
    for (const { name, location, to } of [
      {
        name: "a file in one page's area goes to that page",
        location: 'src/settings/a.tsx:3',
        to: settings,
      },
      { name: 'a line range names the same file', location: 'src/people/b.tsx:3-9', to: people },
      { name: 'a shared file goes to the header', location: 'src/lib/c.ts:1', to: null },
      { name: 'a file in no area goes to the header', location: 'README.md:1', to: null },
      { name: 'a finding naming no file goes to the header', location: null, to: null },
    ]) {
      expect
        .soft(findingTargets([finding(location)], pages, AREAS), `${name}: ${String(location)}`)
        .toEqual([{ finding: finding(location), taskId: to }]);
    }

    const one = mintId('Task');
    expect(
      findingTargets(
        [finding('README.md:1'), finding('src/lib/c.ts:1'), finding(null)],
        [{ taskId: one, areas: [WHOLE_PROJECT_PAGE.name] }],
        [WHOLE_PROJECT_PAGE],
      ).map((t) => t.taskId),
    ).toEqual([one, one, null]);
  });
});

const nothingKept: PutBackKeptWork = () => Promise.resolve({ applied: [], left: [] });

let h: DeliveryHarness;
let scratch: { path: string; cleanup(): void };
/** Whether this test made a harness: the pure rows make none. */
let made = false;
afterEach(() => {
  if (!made) return;
  made = false;
  h.close();
  scratch.cleanup();
});

interface Asked {
  readonly prompt: string;
  readonly effort: string | undefined;
  readonly timeoutMs: number | undefined;
}

function setup(answer: string): {
  deps: PassReviewDeps & Pick<DeliveryHarness['ctx'], 'state' | 'git' | 'logger' | 'clock'>;
  asked: Asked[];
} {
  h = createDeliveryHarness({ areas: AREAS } satisfies Partial<ProjectInput>);
  scratch = tempDir('review-scratch');
  made = true;
  h.state.write((w) => patchProject(w, h.project.id, { defaultRigor: Rigor.Standard }));
  h.commit('src/settings/page.tsx', 'settings\n');
  h.commit('src/people/page.tsx', 'people\n');
  h.git$('push', '-q', 'origin', 'main');
  const asked: Asked[] = [];
  const adapter: Pick<AgentAdapter, 'complete'> = {
    complete: (ask) => {
      asked.push({ prompt: ask.prompt, effort: ask.effort, timeoutMs: ask.timeoutMs });
      return Promise.resolve(answer);
    },
  };
  return {
    deps: {
      ...h.ctx,
      adapter,
      launch: (_account, model) => ({ model, env: {}, expect: { kind: 'any' } as never }),
      scratchRoot: scratch.path,
    },
    asked,
  };
}

async function openedPass(): Promise<{ passId: PassId; settings: TaskDto; people: TaskDto }> {
  const settings = h.addTask('Settings page', { areas: ['settings'] });
  const people = h.addTask('People page', { areas: ['people'] });
  const opened = await openPass(
    h.ctx,
    { projectId: h.project.id, name: 'Polish pages', taskIds: [settings.id, people.id] },
    { leaseMs: 60_000, putBack: nothingKept },
  );
  return { passId: opened.pass.id, settings, people };
}

function write(path: string, content: string): void {
  const file = join(h.repo, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

const review = (deps: Parameters<typeof reviewPassTip>[0], passId: PassId, sha: string) =>
  reviewPassTip(deps, {
    passId,
    sha,
    baseRef: 'refs/remotes/origin/main',
    signal: new AbortController().signal,
  });

describe('reviewPassTip', () => {
  it("offers each finding to its page's thread or the header, sends nothing, and does not review an unchanged tip again", async () => {
    const { deps, asked } = setup(
      [
        '1. MAJOR src/settings/page.tsx:1 the title is wrong',
        '2. MINOR src/lib/util.ts:4 a helper leaks',
      ].join('\n'),
    );
    const { passId, settings, people } = await openedPass();
    const tip = h.commit('src/settings/page.tsx', 'signed off\n');

    expect(await review(deps, passId, tip)).toBe('reviewed');

    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ timeoutMs: 600_000 });
    expect(asked[0]?.effort).toBeTypeOf('string');
    expect(asked[0]?.prompt).toContain('+signed off');
    const thread = listTaskThread(h.store.db, settings.id);
    const notice = thread.find((m) => m.body.includes('the title is wrong'));
    expect(notice).toMatchObject({ author: TaskMessageAuthor.System, kind: 'notice' });
    expect(offeredText(h.store.db, notice?.id ?? ('' as never))).toContain('the title is wrong');
    // Offered, never sent: no builder message was written to any page.
    for (const task of [settings, people])
      expect(
        listTaskThread(h.store.db, task.id).filter((m) => m.author === TaskMessageAuthor.Builder),
      ).toEqual([]);
    expect(getPassProgress(h.store.db, passId)).toMatchObject({
      reviewedSha: tip,
      notices: [
        expect.objectContaining({ kind: PassNoticeKind.Finding, sendable: true }) as unknown,
      ],
    });

    expect(await review(deps, passId, tip)).toBe('unchanged');
    expect(asked).toHaveLength(1);

    // A page reopened for a finding lands another commit: the next review reads only that.
    const next = h.commit('src/people/page.tsx', 'people, fixed\n');
    write('src/settings/page.tsx', 'not landed\n');
    expect(await review(deps, passId, next)).toBe('reviewed');
    expect(asked[1]?.prompt).toContain('+people, fixed');
    expect(asked[1]?.prompt).not.toContain('+signed off');
    expect(asked[1]?.prompt).toContain('only what changed since the last review');
    // The model names the same finding again: the page's thread holds it once.
    expect(
      listTaskThread(h.store.db, settings.id).filter((m) => m.body.includes('the title is wrong')),
    ).toHaveLength(1);
  });

  /** Five files of about 100 kB each on the settings page, one commit each: a diff of about 500 kB. */
  function longPages(): string {
    let tip = '';
    for (const name of ['a', 'b', 'c', 'd', 'e'])
      tip = h.commit(
        `src/settings/${name}.tsx`,
        `${`${name}-long ${'x'.repeat(100)}\n`.repeat(1_000)}${name}-end\n`,
      );
    return tip;
  }

  it('reads on from where a cut review stopped, at the same tip or a small commit after it, and says so until all of it is read', async () => {
    // Each case reviews its own pass from the start: one harness each.
    for (const [i, { name, next }] of [
      { name: 'the same tip', next: () => '' },
      {
        name: 'a small commit after it',
        next: () => h.commit('src/people/page.tsx', 'people, signed\n'),
      },
    ].entries()) {
      if (i > 0) {
        h.close();
        scratch.cleanup();
      }
      const { deps, asked } = setup('No findings.');
      const { passId } = await openedPass();
      const tip = longPages();
      const cut = () =>
        getPassProgress(h.store.db, passId).notices.filter((n) => n.id === 'review-cut');

      expect.soft(await review(deps, passId, tip), name).toBe('reviewed');
      expect.soft(cut(), name).toEqual([
        expect.objectContaining({
          kind: PassNoticeKind.Finding,
          sendable: false,
          text: expect.stringContaining('not reviewed yet') as unknown,
        }),
      ]);
      expect.soft(asked[0]?.prompt, name).toContain('+a-end');
      expect.soft(asked[0]?.prompt, name).not.toContain('+e-end');

      const later = next() || tip;
      expect.soft(await review(deps, passId, later), name).toBe('reviewed');
      // The files the cut review read whole are not read again; the rest, and anything new, are.
      expect.soft(asked[1]?.prompt, name).not.toContain('+a-end');
      expect.soft(asked[1]?.prompt, name).toContain('+d-end');
      expect.soft(asked[1]?.prompt, name).toContain('+e-end');
      if (later !== tip) expect.soft(asked[1]?.prompt, name).toContain('+people, signed');
      expect.soft(cut(), name).toEqual([]);
      expect.soft(getPassProgress(h.store.db, passId).reviewedSha, name).toBe(later);
      expect.soft(await review(deps, passId, later), name).toBe('unchanged');
    }
  });

  it('reads one file longer than a review reads as far as it goes, says so, and moves on', async () => {
    const { deps, asked } = setup('No findings.');
    const { passId } = await openedPass();
    const tip = h.commit('src/settings/page.tsx', `${'x'.repeat(100)}\n`.repeat(5_000));

    expect(await review(deps, passId, tip)).toBe('reviewed');

    expect(getPassProgress(h.store.db, passId).notices).toEqual([
      expect.objectContaining({
        id: 'review-cut',
        text: expect.stringContaining(
          'Too long to review whole, so the rest of each was not reviewed: src/settings/page.tsx.',
        ) as unknown,
      }),
    ]);
    // Nothing else is left to read at this tip: it is not asked again.
    expect(await review(deps, passId, tip)).toBe('unchanged');
    expect(asked).toHaveLength(1);
  });
});
