import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  PassNoticeKind,
  TaskMessageAuthor,
  type AreaDef,
  type Finding,
  type PassId,
  type ProjectInput,
  type TaskDto,
  type TaskId,
} from '@10db/contracts';
import { findFlowByName, getPassProgress, listTaskThread, patchProject } from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { createDeliveryHarness, type DeliveryHarness } from '../../test/delivery-harness';
import { tempDir } from '../../test/fixtures';
import type { SessionAdapter } from '../sessions';
import { openPass, type PutBackKeptWork } from './index';
import { findingTargets, reviewPassTip, type PassReviewDeps } from './pass-review';
import { offeredText } from './send-to-agent';

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
  const settings = 'tsk_settings' as TaskId;
  const people = 'tsk_people' as TaskId;
  const pages = [
    { taskId: settings, areas: ['settings'] },
    { taskId: people, areas: ['people'] },
  ];

  it.each([
    {
      name: "a file in one page's area goes to that page",
      location: 'src/settings/a.tsx:3',
      to: settings,
    },
    { name: 'a line range names the same file', location: 'src/people/b.tsx:3-9', to: people },
    { name: 'a shared file goes to the header', location: 'src/lib/c.ts:1', to: null },
    { name: 'a file in no area goes to the header', location: 'README.md:1', to: null },
    { name: 'a finding naming no file goes to the header', location: null, to: null },
  ])('$name', ({ location, to }) => {
    expect(findingTargets([finding(location)], pages, AREAS)).toEqual([
      { finding: finding(location), taskId: to },
    ]);
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
  const standard = findFlowByName(h.store.db, 'standard');
  if (!standard) throw new Error('the standard flow was not seeded');
  h.state.write((w) => patchProject(w, h.project.id, { flowId: standard.id }));
  h.commit('src/settings/page.tsx', 'settings\n');
  h.commit('src/people/page.tsx', 'people\n');
  h.git$('push', '-q', 'origin', 'main');
  const asked: Asked[] = [];
  const adapter: Pick<SessionAdapter, 'complete'> = {
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

/** The same deps, with the model answering `answer` from now on. */
function setupAnswer<D extends PassReviewDeps>(deps: D, answer: string): D {
  return { ...deps, adapter: { complete: () => Promise.resolve(answer) } };
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
  });

  it('says in the header that a diff too long to read whole was cut', async () => {
    const { deps } = setup('No findings.');
    const { passId } = await openedPass();
    const tip = h.commit('src/settings/page.tsx', `${'x'.repeat(100)}\n`.repeat(5_000));

    expect(await review(deps, passId, tip)).toBe('reviewed');

    expect(getPassProgress(h.store.db, passId).notices).toEqual([
      expect.objectContaining({
        id: 'review-cut',
        kind: PassNoticeKind.Finding,
        sendable: false,
        text: expect.stringContaining('was not reviewed') as unknown,
      }),
    ]);
  });

  it("clears the header's findings of the last review when the next one reads a new tip", async () => {
    const { deps } = setup('1. MAJOR src/lib/util.ts:4 a helper leaks');
    const { passId } = await openedPass();
    const tip = h.commit('src/settings/page.tsx', 'signed off\n');
    await review(deps, passId, tip);
    expect(getPassProgress(h.store.db, passId).notices).toHaveLength(1);

    const fixed = setupAnswer(deps, 'No findings.');
    await review(fixed, passId, h.commit('src/lib/util.ts', 'fixed\n'));

    expect(getPassProgress(h.store.db, passId).notices).toEqual([]);
  });

  it('runs no review for a flow with no review step', async () => {
    const { deps, asked } = setup('No findings.');
    const quick = findFlowByName(h.store.db, 'quick');
    if (!quick) throw new Error('the quick flow was not seeded');
    h.state.write((w) => patchProject(w, h.project.id, { flowId: quick.id }));
    const { passId } = await openedPass();
    const tip = h.commit('src/settings/page.tsx', 'signed off\n');

    expect(await review(deps, passId, tip)).toBe('none');
    expect(asked).toEqual([]);
    expect(getPassProgress(h.store.db, passId).reviewedSha).toBeNull();
  });
});
