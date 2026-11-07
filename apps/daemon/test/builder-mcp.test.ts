import {
  AccountCreatedDto,
  BatchDto,
  BRAINSTORM_REFUSED_ON_CHATGPT,
  BoardColumnDto,
  BUILDER_INSTRUCTIONS,
  BuilderToolName,
  builderToolList,
  InboxKind,
  McpToolName,
  NEW_TASK_NO_AREAS,
  NEW_TASK_NO_CRITERIA,
  ProjectDto,
  QuestionCategory,
  ShapeViewDto,
  TaskDto,
  Urgency,
  WorkstreamState,
  mintId,
} from '@10db/contracts';
import {
  insertBatch,
  insertInboxItem,
  insertWorkstream,
  transitionBatch,
  transitionWorkstream,
} from '@10db/db';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { startDaemon, type RunningDaemon } from '../src/daemon';
import { FakeAdapter } from '../src/sessions';
import { apiClient } from './api-client';
import { FakeGh } from './fake-gh';
import {
  createTempRepo,
  createTempRepoWithOrigin,
  githubOrigin,
  NETWORK_ENV,
  tempDir,
  waitForAsync,
} from './fixtures';
import { seedProfiles } from './seed-profiles';

let data: { path: string; cleanup(): void };
let repo: { path: string; cleanup(): void };
let daemon: RunningDaemon;
let client: Client;
/** Starts a daemon and connects the builder client to it; `extra` adds to the daemon's options. */
async function boot(extra: Partial<Parameters<typeof startDaemon>[0]> = {}) {
  daemon = await startDaemon({
    sandbox: null,
    dataDir: data.path,
    port: 0,
    adapter: new FakeAdapter({}),
    logLevel: 'debug',
    caffeinate: () => null,
    watch: false,
    // A tick long enough that a started task stays where the test left it.
    tickMs: 3_600_000,
    // No lane is free, so a started task stays queued and can be held.
    caps: { global: 0 },
    ...extra,
  });
  // With the catalogue fetch off nothing builds profiles; the fixture's stand in for an account's list.
  seedProfiles(daemon.state);
  client = new Client({ name: 'test', version: '0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${daemon.url}/builder/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${daemon.token}` } },
    }),
  );
}
beforeEach(async () => {
  data = tempDir('builder mcp');
  repo = createTempRepo();
  await boot();
});
afterEach(async () => {
  await client.close();
  await daemon.stop();
  repo.cleanup();
  data.cleanup();
});

const api = () => apiClient(daemon.url, daemon.token);
const Text = z.array(z.object({ type: z.literal('text'), text: z.string() }));

async function call(name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = Text.parse(result.content)
    .map((c) => c.text)
    .join('');
  return { isError: result.isError === true, text };
}
async function callJson(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const result = await call(name, args);
  if (result.isError) throw new Error(`${name} failed: ${result.text}`);
  return z.unknown().parse(JSON.parse(result.text));
}

async function seedProject() {
  return api().post('/projects', ProjectDto, {
    name: 'demo',
    repoPath: repo.path,
    gateCommand: 'true',
    areas: [
      { name: 'src', globs: ['src/**'] },
      { name: 'docs', globs: ['docs/**'] },
    ],
  });
}
const seedTask = (projectId: string, title: string, dependsOn: string[] = []) =>
  api().post(`/projects/${projectId}/tasks`, TaskDto, {
    title,
    acceptanceCriteria: ['x'],
    areas: ['src'],
    dependsOn,
  });
const tasksOf = (projectId: string) => api().get(`/projects/${projectId}/tasks`, z.array(TaskDto));

/** What the REST API answers for a POST, so a refusal can be compared with the MCP one. */
async function restRefusal(path: string, body: unknown) {
  const res = await fetch(`${daemon.url}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${daemon.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: z.unknown().parse(await res.json()) };
}
const RestError = z.object({
  message: z.string().optional(),
  issues: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
});
/** The text the desktop shows for a REST refusal body. */
function restText(body: unknown): string {
  const { message, issues } = RestError.parse(body);
  if (message) return message;
  return (issues ?? []).map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join('; ');
}

describe('the builder MCP endpoint', () => {
  it('lists exactly the builder tools, none of them a lane tool', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(builderToolList().map((t) => t.name));
    const lane = new Set<string>(Object.values(McpToolName));
    expect(tools.filter((t) => lane.has(t.name))).toEqual([]);
    expect(tools.map((t) => t.name).sort()).toEqual(Object.values(BuilderToolName).sort());
  });

  it('sends the drafting instructions', () => {
    expect(client.getInstructions()).toBe(BUILDER_INSTRUCTIONS);
  });

  it('refuses the UI token on the lane endpoint and no token on its own', async () => {
    const lane = await fetch(`${daemon.url}/mcp`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${daemon.token}`, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(lane.status).toBe(401);
    const bare = await fetch(`${daemon.url}/builder/mcp`, { method: 'POST', body: '{}' });
    expect(bare.status).toBe(401);
  });

  it('lists projects with their areas, hazards, columns, flow and delivery', async () => {
    const project = await seedProject();
    const column = await api().post(`/projects/${project.id}/board-columns`, BoardColumnDto, {
      name: 'Later',
    });
    const projects = z
      .array(z.record(z.string(), z.unknown()))
      .parse(await callJson('list_projects'));
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({
      id: project.id,
      name: 'demo',
      areas: [
        { name: 'src', globs: ['src/**'] },
        { name: 'docs', globs: ['docs/**'] },
      ],
      flowId: project.flowId,
      delivery: project.delivery,
    });
    expect(projects[0]?.['hazards']).toContainEqual(
      expect.objectContaining({ name: 'migrations', globs: expect.any(Array) as unknown }),
    );
    expect(projects[0]?.['isolate']).toEqual(['migrations', 'deps']);
    expect(projects[0]?.['columns']).toContainEqual({ id: column.id, name: 'Later' });
  });

  it('marks the catch-all area in list_projects and leaves the others unmarked', async () => {
    await api().post('/projects', ProjectDto, {
      name: 'proposed',
      repoPath: repo.path,
      gateCommand: 'true',
      areas: [
        { name: 'src', globs: ['src/**'] },
        { name: 'root', globs: ['*', '.*'], catchAll: true },
      ],
    });
    const projects = z
      .array(z.object({ areas: z.array(z.record(z.string(), z.unknown())) }).loose())
      .parse(await callJson('list_projects'));
    expect(projects[0]?.areas).toEqual([
      { name: 'src', globs: ['src/**'] },
      { name: 'root', globs: ['*', '.*'], catchAll: true },
    ]);
  });

  it('lists flows', async () => {
    const flows = z.array(z.object({ id: z.string(), name: z.string() }).loose());
    expect(flows.parse(await callJson('list_flows')).length).toBeGreaterThan(0);
  });

  it('lists a project’s open tasks only', async () => {
    const project = await seedProject();
    const open = await seedTask(project.id, 'open');
    const done = await seedTask(project.id, 'done');
    const removed = await seedTask(project.id, 'removed');
    daemon.state.db.$client.prepare("update tasks set status = 'done' where id = ?").run(done.id);
    await call('remove_task', { taskId: removed.id });
    const listed = z
      .array(z.object({ id: z.string() }).loose())
      .parse(await callJson('list_tasks', { projectId: project.id }));
    expect(listed.map((t) => t.id)).toEqual([open.id]);
  });

  describe('create_task', () => {
    it('stores every field and returns the id', async () => {
      const project = await seedProject();
      const first = await seedTask(project.id, 'first');
      const created = z
        .object({ id: z.string(), title: z.string(), boardStatus: z.string() })
        .parse(
          await callJson('create_task', {
            projectId: project.id,
            title: '  Search is fast  ',
            description: ' details ',
            acceptanceCriteria: ['  one ', '', 'two'],
            areas: ['src'],
            dependsOn: [first.id],
            riskTags: ['security'],
            flowId: project.flowId,
          }),
        );
      expect(created.title).toBe('Search is fast');
      const stored = (await tasksOf(project.id)).find((t) => t.id === created.id);
      expect(stored).toMatchObject({
        title: 'Search is fast',
        description: 'details',
        acceptanceCriteria: ['one', 'two'],
        areas: ['src'],
        dependsOn: [first.id],
        riskTags: ['security'],
        flowId: project.flowId,
        boardStatus: created.boardStatus,
      });
    });

    it('stores a trimmed headline and why, as the REST API does', async () => {
      const project = await seedProject();
      const words = { headline: "Odd files can't freeze 10db", why: 'A FIFO hung every lane.' };
      const created = z.object({ id: z.string() }).parse(
        await callJson('create_task', {
          projectId: project.id,
          title: 'Stamping a file never blocks on a FIFO',
          headline: `  ${words.headline} `,
          why: ` ${words.why}  `,
          acceptanceCriteria: ['one'],
          areas: ['src'],
        }),
      );
      const viaRest = await api().post(`/projects/${project.id}/tasks`, TaskDto, {
        title: 'Rest',
        acceptanceCriteria: ['x'],
        areas: ['src'],
        ...words,
      });
      expect(viaRest).toMatchObject(words);
      expect((await tasksOf(project.id)).find((t) => t.id === created.id)).toMatchObject({
        title: 'Stamping a file never blocks on a FIFO',
        ...words,
      });
    });

    it.each([
      ['headline', 'x'.repeat(81)],
      ['why', 'x'.repeat(201)],
      ['headline', 'two\nlines'],
    ])('refuses a bad %s in the REST API’s words, naming the field', async (field, value) => {
      const project = await seedProject();
      const input = {
        projectId: project.id,
        title: 't',
        acceptanceCriteria: ['x'],
        areas: ['src'],
        [field]: value,
      };
      const rest = await restRefusal(`/projects/${project.id}/tasks`, input);
      expect(rest.status).toBe(400);
      expect(restText(rest.body)).toContain(`The ${field} is`);
      const result = await call('create_task', input);
      expect(result.isError).toBe(true);
      expect(result.text).toContain(`The ${field} is`);
    });

    it('lands in the project default unless the call names a landing', async () => {
      const project = await seedProject();
      await api().patch(`/projects/${project.id}`, ProjectDto, { landing: 'hold' });
      const input = {
        projectId: project.id,
        title: 't',
        acceptanceCriteria: ['a'],
        areas: ['src'],
      };
      const Created = z.object({ id: z.string() });
      const plain = Created.parse(await callJson('create_task', input));
      const explicit = Created.parse(
        await callJson('create_task', { ...input, landing: { kind: 'base' } }),
      );
      const stored = await tasksOf(project.id);
      expect(stored.find((t) => t.id === plain.id)?.landing).toEqual({ kind: 'hold' });
      expect(stored.find((t) => t.id === explicit.id)?.landing).toEqual({ kind: 'base' });
    });

    it.each([
      {
        name: 'no criteria',
        args: { acceptanceCriteria: [], areas: ['src'] },
        text: NEW_TASK_NO_CRITERIA,
      },
      {
        name: 'blank criteria',
        args: { acceptanceCriteria: ['  ', ''], areas: ['src'] },
        text: NEW_TASK_NO_CRITERIA,
      },
      { name: 'no areas', args: { acceptanceCriteria: ['a'], areas: [] }, text: NEW_TASK_NO_AREAS },
      { name: 'neither', args: {}, text: NEW_TASK_NO_CRITERIA },
    ])('refuses $name with the form’s words', async ({ args, text }) => {
      const project = await seedProject();
      const result = await call('create_task', { projectId: project.id, title: 't', ...args });
      expect(result).toEqual({ isError: true, text });
      expect(await tasksOf(project.id)).toEqual([]);
    });

    it.each([
      { name: 'an unknown area', body: { areas: ['nope'] } },
      { name: 'an unknown dependency', body: { dependsOn: [mintId('Task')] } },
      { name: 'a title with a newline', body: { title: 'one\ntwo' } },
      { name: 'an empty title', body: { title: '' } },
      { name: 'an unknown flow', body: { flowId: mintId('Flow') } },
    ])('refuses $name as the REST API does', async ({ body }) => {
      const project = await seedProject();
      const input = { title: 't', acceptanceCriteria: ['a'], areas: ['src'], ...body };
      const rest = await restRefusal(`/projects/${project.id}/tasks`, input);
      expect(rest.status).toBeGreaterThanOrEqual(400);
      expect(rest.status).toBeLessThan(500);
      const result = await call('create_task', { projectId: project.id, ...input });
      expect(result).toEqual({ isError: true, text: restText(rest.body) });
      expect(await tasksOf(project.id)).toEqual([]);
    });

    it('refuses an unknown project as the REST API does', async () => {
      await seedProject();
      const projectId = mintId('Project');
      const input = { title: 't', acceptanceCriteria: ['a'], areas: ['src'] };
      const rest = await restRefusal(`/projects/${projectId}/tasks`, input);
      expect(await call('create_task', { projectId, ...input })).toEqual({
        isError: true,
        text: restText(rest.body),
      });
    });
  });

  describe('edit_task', () => {
    it('changes the fields sent and leaves the rest', async () => {
      const project = await seedProject();
      const task = await seedTask(project.id, 'before');
      await callJson('edit_task', {
        taskId: task.id,
        title: ' after ',
        acceptanceCriteria: [' new '],
        riskTags: ['auth'],
      });
      expect((await tasksOf(project.id))[0]).toMatchObject({
        title: 'after',
        acceptanceCriteria: ['new'],
        riskTags: ['auth'],
        areas: ['src'],
      });
    });

    it.each([
      { name: 'nothing to change', args: {}, text: 'Change at least one field' },
      { name: 'empty criteria', args: { acceptanceCriteria: [] }, text: NEW_TASK_NO_CRITERIA },
      { name: 'blank criteria', args: { acceptanceCriteria: ['  '] }, text: NEW_TASK_NO_CRITERIA },
    ])('refuses $name', async ({ args, text }) => {
      const project = await seedProject();
      const task = await seedTask(project.id, 'keep');
      expect(await call('edit_task', { taskId: task.id, ...args })).toEqual({
        isError: true,
        text,
      });
      expect((await tasksOf(project.id))[0]?.acceptanceCriteria).toEqual(['x']);
    });

    it('sets a headline and why, keeps the title, and clears the why with an empty string', async () => {
      const project = await seedProject();
      const task = await seedTask(project.id, 'The precise promise');
      await callJson('edit_task', { taskId: task.id, headline: ' Plain words ', why: 'Because.' });
      expect((await tasksOf(project.id))[0]).toMatchObject({
        title: 'The precise promise',
        headline: 'Plain words',
        why: 'Because.',
      });
      await callJson('edit_task', { taskId: task.id, why: '' });
      expect((await tasksOf(project.id))[0]).toMatchObject({ headline: 'Plain words', why: '' });
      const refused = await call('edit_task', { taskId: task.id, why: 'w'.repeat(201) });
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain('The why is at most 200 characters');
    });

    it('refuses an unknown task', async () => {
      await seedProject();
      const result = await call('edit_task', { taskId: mintId('Task'), title: 'x' });
      expect(result.isError).toBe(true);
    });

    it('sets the areas of an unstarted task and keeps its id', async () => {
      const project = await seedProject();
      const task = await seedTask(project.id, 'move');
      await callJson('edit_task', { taskId: task.id, areas: ['docs', 'src'] });
      const [after] = await tasksOf(project.id);
      expect(after).toMatchObject({ id: task.id, areas: ['docs', 'src'] });
    });

    it('refuses an area the project does not have, naming it', async () => {
      const project = await seedProject();
      const task = await seedTask(project.id, 'keep');
      const result = await call('edit_task', { taskId: task.id, areas: ['src', 'billing'] });
      expect(result.isError).toBe(true);
      expect(result.text).toContain('billing');
      expect((await tasksOf(project.id))[0]?.areas).toEqual(['src']);
    });

    it('changes where an unstarted task lands, and leaves it when landing is not sent', async () => {
      const project = await seedProject();
      const task = await seedTask(project.id, 'lands');
      expect(task.landing).toEqual({ kind: 'base' });
      await callJson('edit_task', { taskId: task.id, landing: { kind: 'hold' } });
      expect((await tasksOf(project.id))[0]?.landing).toEqual({ kind: 'hold' });
      await callJson('edit_task', { taskId: task.id, title: 'renamed' });
      expect((await tasksOf(project.id))[0]?.landing).toEqual({ kind: 'hold' });
    });

    it('refuses a landing that is not one of the three kinds', async () => {
      const project = await seedProject();
      const task = await seedTask(project.id, 'keep');
      const result = await call('edit_task', { taskId: task.id, landing: { kind: 'nowhere' } });
      expect(result.isError).toBe(true);
      expect((await tasksOf(project.id))[0]?.landing).toEqual({ kind: 'base' });
    });

    it('refuses a task that has started when its landing changes, saying why', async () => {
      const project = await seedProject();
      const task = await seedTask(project.id, 'running');
      await callJson('start_task', { taskId: task.id });
      const result = await call('edit_task', { taskId: task.id, landing: { kind: 'hold' } });
      expect(result).toEqual({
        isError: true,
        text: 'running has already started, so where its work lands is fixed',
      });
    });

    it('refuses a task that has started, saying why', async () => {
      const project = await seedProject();
      const task = await seedTask(project.id, 'running');
      await callJson('start_task', { taskId: task.id });
      const result = await call('edit_task', { taskId: task.id, areas: ['docs'] });
      expect(result.isError).toBe(true);
      expect(result.text).toContain('has already started, so its areas are fixed');
      expect((await tasksOf(project.id))[0]?.areas).toEqual(['src']);
    });
  });

  describe('remove_task', () => {
    it('removes an unstarted task', async () => {
      const project = await seedProject();
      const task = await seedTask(project.id, 'gone');
      await callJson('remove_task', { taskId: task.id });
      expect(await tasksOf(project.id)).toEqual([]);
    });

    it('refuses a started task', async () => {
      const project = await seedProject();
      const task = await seedTask(project.id, 'running');
      await callJson('start_task', { taskId: task.id });
      const result = await call('remove_task', { taskId: task.id });
      expect(result.isError).toBe(true);
      expect(result.text).toContain('has started');
      expect(await tasksOf(project.id)).toHaveLength(1);
    });
  });

  describe('start_task', () => {
    it('starts a Ready task', async () => {
      const project = await seedProject();
      const task = await seedTask(project.id, 'go');
      await callJson('start_task', { taskId: task.id });
      expect((await tasksOf(project.id))[0]?.workstreamId).not.toBeNull();
    });

    it('refuses a task that is not Ready, though the REST API would start it', async () => {
      const project = await seedProject();
      const first = await seedTask(project.id, 'first');
      const waiting = await seedTask(project.id, 'waiting', [first.id]);
      expect(await call('start_task', { taskId: waiting.id })).toEqual({
        isError: true,
        text: "Task waiting is backlog, not ready, so it can't be started",
      });
      const after = (await tasksOf(project.id)).find((t) => t.id === waiting.id);
      expect(after?.workstreamId).toBeNull();
    });

    describe('fresh', () => {
      const batchesOf = (projectId: string) =>
        api().get(`/projects/${projectId}/batches`, z.array(BatchDto));

      /** A pull-request project whose only task failed in an OPEN batch of its own. */
      async function failedInOpenBatch() {
        const project = await api().post('/projects', ProjectDto, {
          name: 'demo',
          repoPath: repo.path,
          gateCommand: 'true',
          areas: [{ name: 'src', globs: ['src/**'] }],
          delivery: 'pull_request',
          prTitlePrefix: 'feat(app)',
        });
        const task = await seedTask(project.id, 'Alpha');
        const batchId = daemon.state.write((ctx) => {
          const batch = insertBatch(ctx, {
            projectId: project.id,
            title: 'Alpha',
            baseBranch: 'main',
          });
          transitionBatch(ctx, batch.id, { to: 'OPEN', patch: { branch: 'tendb/alpha' } });
          const ws = insertWorkstream(ctx, task.id, {
            first: { model: 'claude-sonnet-5-5', effort: 'medium' },
            batchId: batch.id,
          });
          for (const to of ['STARTING', 'RUNNING', 'FAILED'] as const)
            transitionWorkstream(ctx, ws.id, { to, fence: null });
          return batch.id;
        });
        return { project, task, batchId };
      }

      it('starts a failed task over in a new batch, abandoning the old one', async () => {
        const { project, task, batchId } = await failedInOpenBatch();
        const result = z
          .object({ taskId: z.string(), batchId: z.string() })
          .parse(await callJson('start_task', { taskId: task.id, fresh: true }));
        expect(result.taskId).toBe(task.id);
        expect(result.batchId).not.toBe(batchId);
        const old = (await batchesOf(project.id)).find((b) => b.id === batchId);
        expect(old?.state).toBe('ABANDONED');
        // The repo has no origin, so the new batch's cut is refused; wait for it before the daemon stops.
        await waitForAsync(async () =>
          (await batchesOf(project.id)).every((b) => b.id !== result.batchId) ? true : undefined,
        );
      });

      it('leaves a failed task alone without it, as before: it is not ready', async () => {
        const { project, task, batchId } = await failedInOpenBatch();
        const result = await call('start_task', { taskId: task.id });
        expect(result.isError).toBe(true);
        expect(result.text).toContain('not ready');
        expect((await batchesOf(project.id)).find((b) => b.id === batchId)?.state).toBe('OPEN');
      });

      it('refuses a failed local task whose dependency is unfinished, starting nothing', async () => {
        const project = await seedProject();
        const first = await seedTask(project.id, 'first');
        const waiting = await seedTask(project.id, 'waiting', [first.id]);
        const failedId = daemon.state.write((ctx) => {
          const ws = insertWorkstream(ctx, waiting.id, {
            first: { model: 'claude-sonnet-5-5', effort: 'medium' },
          });
          for (const to of ['STARTING', 'RUNNING', 'FAILED'] as const)
            transitionWorkstream(ctx, ws.id, { to, fence: null });
          return ws.id;
        });
        const result = await call('start_task', { taskId: waiting.id, fresh: true });
        expect(result).toEqual({
          isError: true,
          text: "Task waiting waits on first, so it can't be started",
        });
        // No new workstream: the task still points at its failed run.
        expect((await tasksOf(project.id)).find((t) => t.id === waiting.id)?.workstreamId).toBe(
          failedId,
        );
      });

      it('is a plain start for a Ready task that never ran', async () => {
        const project = await seedProject();
        const task = await seedTask(project.id, 'first run');
        await callJson('start_task', { taskId: task.id, fresh: true });
        expect((await tasksOf(project.id))[0]?.workstreamId).not.toBeNull();
      });
    });

    describe('a held task', () => {
      const StartResult = z.object({ taskId: z.string(), workstreamId: z.string() });
      const holdPath = (taskId: string) => `/tasks/${taskId}/hold`;

      it('starts again, with the Start the Board sends', async () => {
        const project = await seedProject();
        const task = await seedTask(project.id, 'held');
        const started = StartResult.parse(await callJson('start_task', { taskId: task.id }));
        expect((await restRefusal(holdPath(task.id), {})).status).toBe(200);
        const held = (await tasksOf(project.id))[0];
        expect(held?.boardStatus).toBe('blocked');

        const result = StartResult.parse(await callJson('start_task', { taskId: task.id }));
        expect(result).toEqual({ taskId: task.id, workstreamId: started.workstreamId });
        const runs = await api().get(
          '/workstreams',
          z.array(z.object({ id: z.string(), state: z.string() })),
        );
        expect(runs.find((w) => w.id === started.workstreamId)?.state).toBe(WorkstreamState.Queued);
        expect((await tasksOf(project.id))[0]?.boardStatus).toBe('in_progress');
      });

      it('is refused while its run is in progress', async () => {
        const project = await seedProject();
        const task = await seedTask(project.id, 'running');
        await callJson('start_task', { taskId: task.id });
        const result = await call('start_task', { taskId: task.id });
        expect(result.isError).toBe(true);
        expect(result.text).toContain('in progress');
      });

      it('is still refused while a dependency is unfinished', async () => {
        const project = await seedProject();
        const first = await seedTask(project.id, 'first');
        const waiting = await seedTask(project.id, 'waiting', [first.id]);
        // The REST start queues it behind its dependency; holding sets that run aside.
        await api().post(`/tasks/${waiting.id}/start`, z.unknown());
        expect((await restRefusal(holdPath(waiting.id), {})).status).toBe(200);
        const result = await call('start_task', { taskId: waiting.id });
        expect(result.isError).toBe(true);
        expect(result.text).toContain('waits on');
      });
    });
  });

  describe('run_next', () => {
    const Result = z.object({
      taskId: z.string(),
      workstreamId: z.string(),
      state: z.string(),
      waitingOn: z.array(z.string()),
    });
    const queued = () =>
      api().get(
        '/workstreams',
        z.array(z.object({ id: z.string(), runNextAt: z.string().nullable() })),
      );

    it('puts a queued task first in line, as the Board’s endpoint does', async () => {
      const project = await seedProject();
      const earlier = await seedTask(project.id, 'earlier');
      const later = await seedTask(project.id, 'later');
      await callJson('start_task', { taskId: earlier.id });
      await callJson('start_task', { taskId: later.id });
      const result = Result.parse(await callJson('run_next', { taskId: later.id }));
      const stored = await tasksOf(project.id);
      expect(result).toEqual({
        taskId: later.id,
        workstreamId: stored.find((t) => t.id === later.id)?.workstreamId,
        state: WorkstreamState.Queued,
        waitingOn: [],
      });
      const lines = await queued();
      const earlierId = stored.find((t) => t.id === earlier.id)?.workstreamId;
      expect(lines.find((w) => w.id === result.workstreamId)?.runNextAt).not.toBeNull();
      expect(lines.find((w) => w.id === earlierId)?.runNextAt).toBeNull();
    });

    it('answers the dependencies it still waits on, as the endpoint does', async () => {
      const project = await seedProject();
      const first = await seedTask(project.id, 'first');
      const waiting = await seedTask(project.id, 'waiting', [first.id]);
      // The REST API starts a task whose dependencies are open; the tool refuses that, so use REST.
      const started = await restRefusal(`/tasks/${waiting.id}/start`, {});
      expect(started.status).toBeLessThan(300);
      const result = Result.parse(await callJson('run_next', { taskId: waiting.id }));
      expect(result.waitingOn).toEqual(['first']);
    });

    it.each([
      { name: 'a task that has not started', start: false },
      { name: 'a task already running', start: true },
    ])('refuses $name in the Board’s words', async ({ start }) => {
      const project = await seedProject();
      const task = await seedTask(project.id, 'idle');
      if (start) {
        await callJson('start_task', { taskId: task.id });
        daemon.state.db.$client
          .prepare("update workstreams set state = 'running' where task_id = ?")
          .run(task.id);
      }
      const rest = await restRefusal(`/tasks/${task.id}/run-next`, {});
      expect(rest.status).toBe(409);
      expect(await call('run_next', { taskId: task.id })).toEqual({
        isError: true,
        text: restText(rest.body),
      });
    });

    it('refuses an unknown task as the endpoint does', async () => {
      await seedProject();
      const taskId = mintId('Task');
      const rest = await restRefusal(`/tasks/${taskId}/run-next`, {});
      expect(await call('run_next', { taskId })).toEqual({
        isError: true,
        text: restText(rest.body),
      });
    });
  });

  describe('move_task', () => {
    it('parks a task in a column and returns it to planned', async () => {
      const project = await seedProject();
      const task = await seedTask(project.id, 'park me');
      const column = await api().post(`/projects/${project.id}/board-columns`, BoardColumnDto, {
        name: 'Later',
      });
      await callJson('move_task', { taskId: task.id, to: column.id });
      expect((await tasksOf(project.id))[0]?.boardColumnId).toBe(column.id);
      await callJson('move_task', { taskId: task.id, to: null });
      expect((await tasksOf(project.id))[0]?.boardColumnId).toBeNull();
    });

    it('refuses the same task above and below', async () => {
      const project = await seedProject();
      const task = await seedTask(project.id, 'a');
      const other = await seedTask(project.id, 'b');
      const result = await call('move_task', {
        taskId: task.id,
        to: null,
        after: other.id,
        before: other.id,
      });
      expect(result).toEqual({
        isError: true,
        text: 'before: after and before must be different tasks',
      });
    });
  });

  describe('list_inbox', () => {
    it('shows open cards only, with five keys', async () => {
      const project = await seedProject();
      const card = (title: string) =>
        daemon.state.write((ctx) =>
          insertInboxItem(ctx, {
            projectId: project.id,
            kind: InboxKind.Question,
            title,
            body: 'secret body',
            options: [],
            recommendation: null,
            category: QuestionCategory.Product,
            urgency: Urgency.Normal,
            detail: null,
            foldKey: null,
            targets: [],
          }),
        );
      const open = card('Which database?');
      const resolved = card('Old');
      daemon.state.db.$client
        .prepare("update inbox_items set state = 'RESOLVED' where id = ?")
        .run(resolved.id);
      const listed = z.array(z.record(z.string(), z.unknown())).parse(await callJson('list_inbox'));
      expect(listed).toEqual([
        {
          id: open.id,
          kind: 'question',
          projectId: project.id,
          title: 'Which database?',
          createdAt: open.createdAt,
        },
      ]);
    });
  });

  describe('knowledge', () => {
    const get = async (path: string) =>
      z.record(z.string(), z.unknown()).parse(
        await (
          await fetch(`${daemon.url}${path}`, {
            headers: { Authorization: `Bearer ${daemon.token}` },
          })
        ).json(),
      );
    const Item = z.object({ id: z.string() }).loose();
    const List = z.object({ items: z.array(Item) }).loose();
    const found = async (projectId: string, args: Record<string, unknown> = {}) =>
      List.parse(await callJson('search_knowledge', { projectId, ...args }));

    it('finds what the knowledge route lists for the same words', async () => {
      const project = await seedProject();
      await callJson('save_decision', {
        projectId: project.id,
        question: 'Which queue library?',
        choice: 'BullMQ',
        rationale: 'Redis is already there',
      });
      await callJson('save_principle', {
        projectId: project.id,
        statement: 'Tests never sleep; they wait on a condition.',
        topicKey: 'testing.no-sleeps',
      });
      for (const query of ['q=queue', 'q=sleep', 'kind=principle', 'history=1', '']) {
        const args = Object.fromEntries(new URLSearchParams(query));
        const viaTool = await found(project.id, {
          ...args,
          ...(args['history'] === undefined ? {} : { history: args['history'] === '1' }),
        });
        expect(viaTool, query).toEqual(await get(`/projects/${project.id}/knowledge?${query}`));
      }
      expect((await found(project.id, { q: 'queue' })).items).toHaveLength(1);
    });

    it('writes, replaces, retires and withdraws, each showing the MCP server and the quote', async () => {
      const project = await seedProject();
      const first = Item.parse(
        await callJson('save_decision', {
          projectId: project.id,
          question: 'Which queue library?',
          choice: 'BullMQ',
          rationale: 'Redis is already there',
          quote: 'use BullMQ',
        }),
      );
      const second = Item.parse(
        await callJson('supersede_knowledge', {
          id: first.id,
          choice: 'pg-boss',
          quote: 'actually pg-boss',
        }),
      );
      expect((await found(project.id)).items.map((i) => i.id)).toEqual([second.id]);
      const rule = Item.parse(
        await callJson('save_principle', {
          projectId: project.id,
          statement: 'Tests never sleep',
          quote: 'never sleep in a test',
        }),
      );
      await callJson('retire_knowledge', {
        id: rule.id,
        reason: 'No more tests.',
        quote: 'drop it',
      });
      await callJson('withdraw_knowledge', {
        id: second.id,
        reason: 'Wrong project.',
        quote: 'that was the wrong repo',
      });
      expect((await found(project.id)).items.map((i) => i.id)).toEqual([first.id]);
      expect(
        (await found(project.id, { history: true })).items.map((i) => i.id).toSorted(),
      ).toEqual([first.id, second.id, rule.id].toSorted());
      expect(await get(`/decisions/${first.id}/provenance`)).toMatchObject({
        origin: { via: 'builder_mcp' },
        quote: 'use BullMQ',
      });
      expect(await get(`/decisions/${second.id}/provenance`)).toMatchObject({
        origin: { via: 'builder_mcp' },
        quote: 'actually pg-boss',
        withdrawn: { source: { via: 'builder_mcp', quote: 'that was the wrong repo' } },
      });
      expect(await get(`/principles/${rule.id}/provenance`)).toMatchObject({
        origin: { via: 'builder_mcp' },
        quote: 'never sleep in a test',
        retired: { source: { via: 'builder_mcp', quote: 'drop it' } },
      });
    });

    it('answers a refusal with the words the API gives', async () => {
      const project = await seedProject();
      const rest = await restRefusal(`/projects/${project.id}/decisions`, {
        scope: 'area',
        area: 'billing',
        question: 'q',
        choice: 'c',
        rationale: 'r',
      });
      expect(rest.status).toBe(400);
      const tool = await call('save_decision', {
        projectId: project.id,
        scope: 'area',
        area: 'billing',
        question: 'q',
        choice: 'c',
        rationale: 'r',
      });
      expect(tool.isError).toBe(true);
      expect(tool.text).toBe(restText(rest.body));
      expect(tool.text).toContain('has no area named billing');
      const search = await call('search_knowledge', { projectId: project.id, area: 'billing' });
      expect(search).toEqual({ isError: true, text: tool.text });
    });

    it('lists no proposal when none waits', async () => {
      const project = await seedProject();
      expect(await callJson('list_proposals', { projectId: project.id })).toEqual([]);
    });
  });

  describe('start_shape', () => {
    const view = async (id: string) => {
      const res = await fetch(`${daemon.url}/shapes/${id}`, {
        headers: { Authorization: `Bearer ${daemon.token}` },
      });
      return ShapeViewDto.parse(await res.json());
    };

    it('creates a conversation from the summary and the text files, and starts no turn', async () => {
      const project = await seedProject();
      const made = z.object({ id: z.string(), title: z.string() }).parse(
        await callJson('start_shape', {
          projectId: project.id,
          title: 'Board polish',
          summary: 'We settled on denser cards.',
          files: [{ name: 'notes.md', content: '# Notes' }],
        }),
      );
      expect(made.title).toBe('Board polish');
      const shown = await view(made.id);
      expect(shown.shape).toMatchObject({ origin: 'claude_code', round: 0 });
      expect(shown.messages.map((m) => [m.author, m.body])).toEqual([
        ['note', 'From a Claude Code session'],
        ['builder', 'We settled on denser cards.'],
      ]);
      expect(shown.files.map((f) => f.name)).toEqual(['notes.md']);
      expect(readFileSync(shown.files[0]?.storedPath ?? '', 'utf8')).toBe('# Notes');
      expect(shown.turn).toEqual({
        running: false,
        queued: 0,
        proposing: false,
        rehearsing: false,
        waitingForUpdate: false,
      });
    });

    it.each([
      {
        name: 'a path',
        file: { name: '/Users/me/.ssh/config', content: 'x' },
        says: /never a path/,
      },
      {
        name: 'an image',
        file: { name: 'shot.png', content: 'x' },
        says: /Markdown or plain text/,
      },
      {
        name: 'more than 256 KB',
        file: { name: 'big.md', content: 'x'.repeat(256 * 1024 + 1) },
        says: /256 KB/,
      },
    ])('refuses $name, creating nothing', async ({ file, says }) => {
      const project = await seedProject();
      const result = await call('start_shape', {
        projectId: project.id,
        title: 'Board polish',
        summary: 'Summary',
        files: [file],
      });
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(says);
      const listed = await fetch(`${daemon.url}/projects/${project.id}/shapes`, {
        headers: { Authorization: `Bearer ${daemon.token}` },
      });
      expect(await listed.json()).toEqual([]);
    });

    it('refuses a project on a ChatGPT account with the daemon’s words, creating nothing', async () => {
      const project = await seedProject();
      const { account } = await api().post('/accounts', AccountCreatedDto, {
        kind: 'codex_signin',
        label: 'ChatGPT plan',
      });
      await api().patch(`/projects/${project.id}`, ProjectDto, { accountId: account.id });
      const result = await call('start_shape', {
        projectId: project.id,
        title: 'Board polish',
        summary: 'Summary',
      });
      expect(result.isError).toBe(true);
      expect(result.text).toContain(BRAINSTORM_REFUSED_ON_CHATGPT);
      const listed = await fetch(`${daemon.url}/projects/${project.id}/shapes`, {
        headers: { Authorization: `Bearer ${daemon.token}` },
      });
      expect(await listed.json()).toEqual([]);
    });

    it('refuses a project that does not exist', async () => {
      const result = await call('start_shape', {
        projectId: mintId('Project'),
        title: 'T',
        summary: 'S',
      });
      expect(result.isError).toBe(true);
    });
  });

  describe('a landing branch origin lacks', () => {
    let remote: ReturnType<typeof createTempRepoWithOrigin>;
    let network: ReturnType<typeof githubOrigin>;
    const MISSING = (what: string) =>
      `origin has no branch named missing. Create it on origin, or choose another place for ${what} to land.`;

    beforeEach(async () => {
      // Replace the daemon the outer hook started with one whose project has a real origin.
      await client.close();
      await daemon.stop();
      repo.cleanup();
      remote = createTempRepoWithOrigin();
      repo = remote.repo;
      network = githubOrigin(remote.repo.path, remote.origin.path);
      await boot({
        gh: new FakeGh(),
        networkEnv: () => ({ ...NETWORK_ENV, GIT_CONFIG_GLOBAL: network.global }),
      });
    });
    afterEach(() => {
      remote.origin.cleanup();
      network.cleanup();
    });

    const seedPullRequestProject = () =>
      api().post('/projects', ProjectDto, {
        name: 'demo',
        repoPath: repo.path,
        gateCommand: 'true',
        areas: [{ name: 'src', globs: ['src/**'] }],
        delivery: 'pull_request',
        prTitlePrefix: 'feat(app)',
      });

    it('edit_task refuses it in the API’s words and leaves the task’s landing', async () => {
      const project = await seedPullRequestProject();
      const task = await seedTask(project.id, 'keep');
      const result = await call('edit_task', {
        taskId: task.id,
        landing: { kind: 'branch', branch: 'missing' },
      });
      expect(result).toEqual({ isError: true, text: MISSING('this task') });
      expect((await tasksOf(project.id))[0]?.landing).toEqual({ kind: 'base' });
    });

    it('create_task refuses it in the API’s words and creates no task', async () => {
      const project = await seedPullRequestProject();
      const input = {
        title: 't',
        acceptanceCriteria: ['a'],
        areas: ['src'],
        landing: { kind: 'branch', branch: 'missing' },
      };
      const rest = await restRefusal(`/projects/${project.id}/tasks`, input);
      expect(rest.status).toBe(400);
      const result = await call('create_task', { projectId: project.id, ...input });
      expect(result).toEqual({ isError: true, text: MISSING('this task') });
      expect(result.text).toBe(restText(rest.body));
      expect(await tasksOf(project.id)).toEqual([]);
    });
  });

  it('answers an unknown tool as an error result', async () => {
    const result = await call('answer_card', {});
    expect(result.isError).toBe(true);
  });
});
