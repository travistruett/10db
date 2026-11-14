import {
  AccountCreatedDto,
  AccountDto,
  JudgeCallsPageDto,
  JudgeStatusDto,
  KindDto,
  ProjectDto,
  TaskDto,
  WorkstreamDto,
} from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { RunningDaemon } from '../src/daemon';
import { FakeAdapter } from '../src/sessions';
import { apiClient } from './api-client';
import { createMemoryKeychain, createTempRepo, tempDir, waitForAsync } from './fixtures';
import { startDaemonWithProfiles } from './daemon-with-profiles';

let data: { path: string; cleanup(): void };
let repo: { path: string; cleanup(): void };
let daemon: RunningDaemon | null;
/** Each question OpenRouter was asked, held until a test lets it answer. */
let held: { readonly rigor: boolean; answer(): void }[];

beforeEach(() => {
  data = tempDir('task sizing');
  repo = createTempRepo();
  daemon = null;
  held = [];
});
afterEach(async () => {
  for (const call of held) call.answer();
  await daemon?.stop();
  repo.cleanup();
  data.cleanup();
});

/** A daemon whose judge is a fake OpenRouter that holds every question; a start waits `sizingWaitMs`. */
async function start(sizingWaitMs: number) {
  daemon = await startDaemonWithProfiles({
    sandbox: null,
    dataDir: data.path,
    port: 0,
    adapter: new FakeAdapter({}),
    logLevel: 'warn',
    caffeinate: () => null,
    watch: false,
    caps: { global: 0 },
    tickMs: 3_600_000,
    keychain: createMemoryKeychain(),
    sizingWaitMs,
    fetch: (_url, init) =>
      new Promise<Response>((resolve) => {
        const rigor = typeof init?.body === 'string' && init.body.includes('"careful"');
        held.push({
          rigor,
          answer: () => {
            const choice = rigor ? 'critical' : 'no';
            resolve(
              Response.json({
                model: 'typesafe/jev-1.13',
                answers: {
                  decision: {
                    type: 'choice',
                    choice,
                    confidence: 0.95,
                    probabilities: { [choice]: 0.95 },
                  },
                },
                usage: { input_tokens: 10, output_tokens: 2, cost: 0 },
              }),
            );
          },
        });
      }),
  });
  const api = apiClient(daemon.url, daemon.token);
  const { account } = await api.post('/accounts', AccountCreatedDto, {
    kind: 'openrouter',
    label: 'OpenRouter',
  });
  await api.put(`/accounts/${account.id}/secret`, AccountDto, {
    secret: 'a-fake-key-for-the-test',
  });
  await api.patch('/judge', JudgeStatusDto, { accountId: account.id });
  const project = await api.post('/projects', ProjectDto, {
    name: 'demo',
    repoPath: repo.path,
    gateCommand: 'true',
    areas: [{ name: 'src', globs: ['src/**'] }],
  });
  const task = await api.post(`/projects/${project.id}/tasks`, TaskDto, {
    title: 'Sized',
    acceptanceCriteria: ['x'],
    areas: ['src'],
  });
  // One question for the rigor and one for each kind the rules did not settle: all of them are held.
  const questions = (await api.get('/kinds', z.array(KindDto))).length + 1;
  await waitForAsync(() => Promise.resolve(held.length === questions));
  return { api, project, task };
}

const taskOf = async (api: ReturnType<typeof apiClient>, projectId: string, id: string) =>
  (await api.get(`/projects/${projectId}/tasks`, z.array(TaskDto))).find((t) => t.id === id);

const callsOf = (api: ReturnType<typeof apiClient>) =>
  api.get('/judge/calls/page?decision=task_rigor', JudgeCallsPageDto);

describe('POST /tasks/:id/start while the judge is sizing', () => {
  it('waits for the answer, then starts on the sized task', async () => {
    const { api, project, task } = await start(30_000);
    const starting = api.post(`/tasks/${task.id}/start`, WorkstreamDto);
    // The start is parked on the sizing: nothing has answered, so nothing has started.
    expect(await taskOf(api, project.id, task.id)).toMatchObject({ workstreamId: null });
    for (const call of held) call.answer();
    const run = await starting;
    expect(await taskOf(api, project.id, task.id)).toMatchObject({
      workstreamId: run.id,
      rigor: 'critical',
      rigorSource: 'judge',
    });
  });

  it('goes on with the rules’ answer after the wait, and the late answer is stopped', async () => {
    const { api, project, task } = await start(50);
    const run = await api.post(`/tasks/${task.id}/start`, WorkstreamDto);
    expect(await taskOf(api, project.id, task.id)).toMatchObject({
      workstreamId: run.id,
      rigor: null,
      sizedByRules: true,
    });
    for (const call of held) call.answer();
    await waitForAsync(async () => (await callsOf(api)).calls[0]?.outcome === 'stopped');
    expect(await taskOf(api, project.id, task.id)).toMatchObject({ rigor: null });
  });
});

describe('a daemon start', () => {
  it('sizes the tasks made while it was down', async () => {
    const { api, project, task } = await start(50);
    for (const call of held) call.answer();
    await waitForAsync(async () => (await taskOf(api, project.id, task.id))?.rigor === 'critical');
    // As if the task had been made by a daemon that never sized it.
    daemon?.state.db.$client
      .prepare('UPDATE tasks SET sized_for = NULL, rigor = NULL, rigor_source = NULL WHERE id = ?')
      .run(task.id);
    await daemon?.stop();
    daemon = await startDaemonWithProfiles({
      sandbox: null,
      dataDir: data.path,
      port: 0,
      adapter: new FakeAdapter({}),
      logLevel: 'warn',
      caffeinate: () => null,
      watch: false,
      tickMs: 3_600_000,
      keychain: createMemoryKeychain(),
      // Made just now, so the judge is asked: it can't be reached, and the rules' value stands.
      fetch: () => Promise.reject(new Error('no network')),
    });
    const sizedFor = (): unknown =>
      daemon?.state.db.$client.prepare('SELECT sized_for FROM tasks WHERE id = ?').get(task.id);
    await waitForAsync(() => Promise.resolve(JSON.stringify(sizedFor()) !== '{"sized_for":null}'));
    expect(sizedFor()).not.toMatchObject({ sized_for: null });
  });
});
