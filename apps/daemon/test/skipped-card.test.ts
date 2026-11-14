import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { InboxKind, type WorkstreamId } from '@10db/contracts';
import { getWorkstream, listInbox, listSkipsForWorkstream, recordSkip } from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { raiseSkippedCard, sweepUnlistedRuns, SKIPPED_DETAIL } from '../src/delivery';
import { createGit } from '../src/git';
import { silentLogger } from '../src/log';
import type { FakeScriptBook } from '../src/sessions';
import { createTestEngine, type TestEngine } from './engine';
import { isolatedGitEnv, waitFor } from './fixtures';

// Every ended unattended run with something new to say raises one item, after a crash, a recovery or
// a retry too, listing every row and what clears each.

type FakeStep = FakeScriptBook[string][number][number];

let engine: TestEngine;
afterEach(async () => {
  await engine.close();
});

const turn: FakeStep = { do: 'turn_complete' };
const bash = (command: string): FakeStep => ({ do: 'tool', toolName: 'Bash', input: { command } });
const write = (path: string): FakeStep => ({
  do: 'tool',
  toolName: 'Write',
  input: { file_path: path, content: 'x' },
});
const commit = (opId: string, paths: string[]): FakeStep => ({
  do: 'mcp',
  tool: 'commit',
  args: { opId, paths, message: 'work' },
});
const ask: FakeStep = {
  do: 'mcp',
  tool: 'ask_human',
  args: {
    opId: 'op-skipped-q-01',
    category: 'design',
    question: 'Teal or red?',
    options: [
      { label: 'Teal', description: '' },
      { label: 'Red', description: '' },
    ],
  },
};
// Commits a file so the run is DONE: a step with nothing committed is sent back.
const finish = (opId: string): FakeStep[] => [
  write('src/api/a.txt'),
  commit(opId, ['src/api/a.txt']),
  turn,
];

const deps = () => ({ state: engine.state, git: createGit(), log: silentLogger });
const items = () =>
  listInbox(engine.store.db, {}).filter(
    (i) => i.kind === InboxKind.Flag && i.detail?.[SKIPPED_DETAIL] !== undefined,
  );

/** Root config sits in an area of its own, so a task that claims it may commit it. */
const ROOT_CONFIG = { name: 'config', globs: ['.mcp.json', '.vscode/**'] };

async function ended(steps: FakeStep[]): Promise<WorkstreamId> {
  engine = await createTestEngine(
    { Alpha: [steps] },
    {
      areas: [
        { name: 'api', globs: ['src/api/**'] },
        { name: 'ui', globs: ['src/ui/**'] },
        ROOT_CONFIG,
      ],
    },
  );
  const { workstream } = engine.addTask('Alpha', ['api', 'config']);
  engine.launch(workstream.id);
  await engine.runner.idle();
  return workstream.id;
}

describe('Skipped while you were away', () => {
  it('a run with two skips raises one item with both', async () => {
    const id = await ended([
      bash('curl -s https://a.example'),
      bash('curl -s https://b.example'),
      ...finish('op-skipped-001'),
    ]);
    expect(getWorkstream(engine.store.db, id).state).toBe('DONE');
    await raiseSkippedCard(deps(), id);
    await raiseSkippedCard(deps(), id);
    const [item, ...more] = items();
    expect(more).toEqual([]);
    expect(item?.title).toBe('Skipped while you were away: Alpha');
    expect(item?.body).toBe(
      [
        '10db skipped 2 calls this task would have needed you for:',
        "- curl -s https://a.example (This call needs a person's approval on this account, and nobody is watching this task.)",
        "- curl -s https://b.example (This call needs a person's approval on this account, and nobody is watching this task.)",
      ].join('\n'),
    );
    expect(item?.options.map((o) => o.label)).toEqual(['Run these now', 'Dismiss']);
  });

  it('a run with none, no questions and no config raises none', async () => {
    const id = await ended(finish('op-skipped-002'));
    await raiseSkippedCard(deps(), id);
    expect(items()).toEqual([]);
  });

  it('a run that only asked questions raises an item listing them', async () => {
    const id = await ended([ask, ...finish('op-skipped-003')]);
    await raiseSkippedCard(deps(), id);
    expect(items()[0]?.body).toBe('Questions it would have asked:\n- Teal or red?');
  });

  it('a run that wrote .mcp.json lists it', async () => {
    const id = await ended([
      write('.mcp.json'),
      write('src/api/a.txt'),
      commit('op-skipped-004', ['.mcp.json', 'src/api/a.txt']),
      turn,
    ]);
    await raiseSkippedCard(deps(), id);
    expect(items()[0]?.body).toBe(
      'Config this task wrote, which runs only after you approve it:\n- .mcp.json',
    );
  });

  it("the changed paths can't be read: the skips are listed and the item says so", async () => {
    const id = await ended([bash('curl -s https://a.example'), ...finish('op-skipped-005')]);
    await raiseSkippedCard(
      {
        ...deps(),
        git: {
          changedFilesSince: () => Promise.reject(new Error('the worktree is gone')),
          head: () => Promise.reject(new Error('the worktree is gone')),
        },
      },
      id,
    );
    expect(items()[0]?.body).toMatch(
      /\n\n10db couldn't read which config files this task changed\.$/,
    );
    expect(items()[0]?.body).toMatch(/^10db skipped 1 call /);
  });

  it('a cancelled run raises none', async () => {
    engine = await createTestEngine({
      Alpha: [[bash('curl -s https://a.example'), { do: 'await_signal', name: 'never' }, turn]],
    });
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    await waitFor(() => listSkipsForWorkstream(engine.store.db, workstream.id)[0]);
    await engine.runner.cancel(workstream.id);
    await engine.runner.idle();
    await raiseSkippedCard(deps(), workstream.id);
    await sweepUnlistedRuns(deps());
    expect(items()).toEqual([]);
  });

  it('twenty-five skips are all listed, and their ids are in the detail', async () => {
    const id = await ended(finish('op-skipped-006'));
    const ids = engine.state.write((ctx) =>
      Array.from({ length: 25 }, (_, i) =>
        recordSkip(ctx, {
          workstreamId: id,
          sessionId: null,
          toolName: 'Bash',
          toolUseId: `tu-${String(i)}`,
          callKey: `key-${String(i)}`,
          summary: `curl -s https://${String(i)}.example`,
          kind: 'default_mode_card',
          limit: null,
          reason: 'nobody',
          source: 'broker',
        }),
      ),
    );
    await raiseSkippedCard(deps(), id);
    const [item] = items();
    expect(item?.body.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(25);
    expect(item?.detail?.['skipIds']).toEqual(ids);
  });

  it('failed, then retried, then done raises a second item with only the new skips', async () => {
    engine = await createTestEngine({
      Alpha: [
        [
          bash('curl -s https://first.example'),
          { do: 'mcp', tool: 'report_blocked', args: { reason: 'It needs the network' } },
          turn,
        ],
        // The fake numbers its calls per session: the write keeps this call's id apart from the first's.
        [
          write('src/api/a.txt'),
          bash('curl -s https://second.example'),
          commit('op-skipped-007', ['src/api/a.txt']),
          turn,
        ],
      ],
    });
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(getWorkstream(engine.store.db, workstream.id).state).toBe('FAILED');
    await raiseSkippedCard(deps(), workstream.id);
    const retried = engine.retry(workstream.id);
    engine.launch(retried.id);
    await engine.runner.idle();
    expect(getWorkstream(engine.store.db, retried.id).state).toBe('DONE');
    await raiseSkippedCard(deps(), retried.id);
    const bodies = items().map((i) => i.body);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toContain('first.example');
    expect(bodies[1]).toContain('second.example');
    expect(bodies[1]).not.toContain('first.example');
  });

  it('a restart between DONE and the item raises it once at start-up', async () => {
    const id = await ended([bash('curl -s https://a.example'), ...finish('op-skipped-008')]);
    await sweepUnlistedRuns(deps());
    await sweepUnlistedRuns(deps());
    expect(items()).toHaveLength(1);
    expect(items()[0]?.detail?.[SKIPPED_DETAIL]).toBe(id);
  });

  it('a run that only wrote config, missed by a restart, is raised by the sweep', async () => {
    await ended([
      write('.vscode/tasks.json'),
      write('src/api/a.txt'),
      commit('op-skipped-009', ['.vscode/tasks.json', 'src/api/a.txt']),
      turn,
    ]);
    await sweepUnlistedRuns(deps());
    expect(items()[0]?.body).toContain('- .vscode/tasks.json');
  });

  it('the sweep after an item was raised raises nothing', async () => {
    const id = await ended([bash('curl -s https://a.example'), ...finish('op-skipped-010')]);
    await raiseSkippedCard(deps(), id);
    await sweepUnlistedRuns(deps());
    expect(items()).toHaveLength(1);
  });

  // Each ending lists the config written since the last check that read it, so none goes unlisted.
  it('a later ending lists the config written since the first item, and only that', async () => {
    const id = await ended([
      write('.mcp.json'),
      write('src/api/a.txt'),
      commit('op-skipped-011', ['.mcp.json', 'src/api/a.txt']),
      turn,
    ]);
    await raiseSkippedCard(deps(), id);
    mkdirSync(join(engine.repoPath, '.vscode'), { recursive: true });
    writeFileSync(join(engine.repoPath, '.vscode', 'tasks.json'), '{}');
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', engine.repoPath, ...args], { env: isolatedGitEnv() });
    git('add', '.vscode/tasks.json');
    git('commit', '-q', '-m', 'a later ending');
    await raiseSkippedCard(deps(), id);
    expect(items().map((i) => i.body)).toEqual([
      'Config this task wrote, which runs only after you approve it:\n- .mcp.json',
      'Config this task wrote, which runs only after you approve it:\n- .vscode/tasks.json',
    ]);
  });

  it("a check that couldn't read the changed paths leaves them to the next ending", async () => {
    const id = await ended([
      write('.mcp.json'),
      write('src/api/a.txt'),
      commit('op-skipped-012', ['.mcp.json', 'src/api/a.txt']),
      turn,
    ]);
    await raiseSkippedCard(
      {
        ...deps(),
        git: {
          changedFilesSince: () => Promise.reject(new Error('the worktree is gone')),
          head: () => Promise.reject(new Error('the worktree is gone')),
        },
      },
      id,
    );
    await raiseSkippedCard(deps(), id);
    expect(items().map((i) => i.body)).toEqual([
      'Config this task wrote, which runs only after you approve it:\n- .mcp.json',
    ]);
  });
});
