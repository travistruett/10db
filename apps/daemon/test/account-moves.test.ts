import {
  AccountCreatedDto,
  AccountDto,
  InboxItemDto,
  ProjectDto,
  TaskDto,
  WorkstreamDto,
} from '@10db/contracts';
import { listSessions } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { startDaemon, type RunningDaemon } from '../src/daemon';
import { FakeAdapter, type FakeScriptBook } from '../src/sessions';
import { apiClient, quickFlowId } from './api-client';
import {
  createMemoryKeychain,
  createTempRepo,
  handoffArgs,
  tempDir,
  waitForAsync,
} from './fixtures';

const QUIET = { caffeinate: () => null, watch: false } as const;

let data: { path: string; cleanup(): void };
let repo: { path: string; cleanup(): void };
let daemon: RunningDaemon | null;
beforeEach(() => {
  data = tempDir('account moves');
  repo = createTempRepo();
  daemon = null;
});
afterEach(async () => {
  await daemon?.stop();
  repo.cleanup();
  data.cleanup();
});

/**
 * A fresh daemon with a confirmed second subscription, and a project on the default account that
 * names it as its fallback; runs one task to Done and reports where its sessions ran.
 */
async function runOnFallback(book: FakeScriptBook) {
  const adapter = new FakeAdapter(book);
  const running = await startDaemon({
    sandbox: null,
    dataDir: data.path,
    port: 0,
    adapter,
    logLevel: 'warn',
    keychain: createMemoryKeychain(),
    ...QUIET,
  });
  daemon = running;
  const api = apiClient(running.url, running.token);
  const { account: fallback } = await api.post('/accounts', AccountCreatedDto, {
    kind: 'claude_subscription',
    label: 'Second plan',
  });
  await api.patch(`/accounts/${fallback.id}`, AccountDto, {
    expectedIdentity: 'second@example.com',
  });
  const project = await api.post('/projects', ProjectDto, {
    name: 'demo',
    repoPath: repo.path,
    gateCommand: 'true',
    flowId: await quickFlowId(api),
    areas: [{ name: 'src', globs: ['src/**'] }],
    fallbackAccountId: fallback.id,
  });
  const task = await api.post(`/projects/${project.id}/tasks`, TaskDto, {
    title: 'Alpha',
    acceptanceCriteria: ['it works'],
    areas: ['src'],
  });
  await api.post(`/tasks/${task.id}/start`, z.unknown());
  const done = await waitForAsync(async () =>
    (await api.get('/workstreams?active=false', z.array(WorkstreamDto))).find(
      (w) => w.taskId === task.id && w.state === 'DONE',
    ),
  );
  return {
    adapter,
    fallback,
    home: project.accountId,
    project: (await api.get('/projects', z.array(ProjectDto))).find((p) => p.id === project.id),
    titles: (await api.get('/inbox', z.array(InboxItemDto))).map((i) => i.title),
    ranOn: listSessions(running.state.db, done.id).map((s) => s.accountId),
  };
}

describe('moving to a fallback account', () => {
  it('hands a lane off and finishes the task on the fallback when the subscription nears its limit', async () => {
    const run = await runOnFallback({
      Alpha: [
        [
          {
            do: 'rate_limit',
            status: 'allowed_warning',
            resetsInSeconds: 3600,
            utilization: 0.96,
            limitType: 'five_hour',
          },
          { do: 'await_message', contains: 'near its usage limit' },
          {
            do: 'mcp',
            tool: 'write_handoff',
            args: handoffArgs('op-fallback-01', 'Write the second file'),
          },
          { do: 'turn_complete' },
        ],
        [{ do: 'turn_complete' }],
      ],
    });
    expect(run.project).toMatchObject({
      accountId: run.fallback.id,
      movedFromAccountId: run.home,
    });
    expect(run.ranOn).toEqual([run.home, run.fallback.id]);
    expect(run.adapter.prompts[1]?.prompt).toContain('Next action: Write the second file');
    expect(run.titles).toContain(
      'demo moved to Second plan: Claude plan is at 96% of its 5-hour limit',
    );
  });

  it('moves to the fallback at the hard limit and finishes the task there from the handoff', async () => {
    const run = await runOnFallback({
      Alpha: [
        [
          {
            do: 'mcp',
            tool: 'write_handoff',
            args: handoffArgs('op-fallback-02', 'Write the second file'),
          },
          { do: 'rate_limit', status: 'rejected', resetsInSeconds: 3600, limitType: 'five_hour' },
        ],
        [{ do: 'turn_complete' }],
      ],
    });
    expect(run.project?.accountId).toBe(run.fallback.id);
    expect(run.ranOn).toEqual([run.home, run.fallback.id]);
    expect(run.adapter.prompts[1]).toMatchObject({ resume: null });
    expect(run.adapter.prompts[1]?.prompt).toContain('Next action: Write the second file');
    expect(run.titles).toContain('demo moved to Second plan: Claude plan reached its 5-hour limit');
    expect(run.titles).not.toContain('Claude plan usage limit reached');
  });
});
