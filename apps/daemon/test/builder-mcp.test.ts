import {
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
  TaskDto,
  Urgency,
  mintId,
} from '@10db/contracts';
import { insertInboxItem } from '@10db/db';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { startDaemon, type RunningDaemon } from '../src/daemon';
import { FakeAdapter } from '../src/sessions';
import { apiClient } from './api-client';
import { createTempRepo, tempDir } from './fixtures';

let data: { path: string; cleanup(): void };
let repo: { path: string; cleanup(): void };
let daemon: RunningDaemon;
let client: Client;
beforeEach(async () => {
  data = tempDir('builder mcp');
  repo = createTempRepo();
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
  });
  client = new Client({ name: 'test', version: '0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${daemon.url}/builder/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${daemon.token}` } },
    }),
  );
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
    areas: [{ name: 'src', globs: ['src/**'] }],
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
      areas: [{ name: 'src', globs: ['src/**'] }],
      flowId: project.flowId,
      delivery: project.delivery,
    });
    expect(projects[0]?.['hazards']).toContainEqual(
      expect.objectContaining({ name: 'migrations', globs: expect.any(Array) as unknown }),
    );
    expect(projects[0]?.['columns']).toContainEqual({ id: column.id, name: 'Later' });
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

    it('refuses an unknown task', async () => {
      await seedProject();
      const result = await call('edit_task', { taskId: mintId('Task'), title: 'x' });
      expect(result.isError).toBe(true);
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

  it('answers an unknown tool as an error result', async () => {
    const result = await call('answer_card', {});
    expect(result.isError).toBe(true);
  });
});
