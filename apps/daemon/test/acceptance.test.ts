import { execFileSync } from 'node:child_process';
import { DaemonEvent, InboxItemDto, ProjectDto, TaskDto, WorkstreamDto } from '@10db/contracts';
import { listEvidence, listSessions, schema } from '@10db/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { startDaemon, type RunningDaemon } from '../src/daemon';
import { FakeAdapter, type FakeScriptBook } from '../src/sessions';
import { apiClient, quickFlowId } from './api-client';
import {
  createTempRepo,
  handoffArgs,
  isolatedGitEnv,
  tempDir,
  waitForAsync,
  type TempDir,
} from './fixtures';

const write = (path: string) => ({
  do: 'tool' as const,
  toolName: 'Write',
  input: { file_path: path, content: `${path}\n` },
});
const commit = (opId: string, path: string) => ({
  do: 'mcp' as const,
  tool: 'commit',
  args: { opId, paths: [path], message: `Add ${path}` },
});
const turn = { do: 'turn_complete' as const };

const BOOK: FakeScriptBook = {
  Alpha: [
    [
      write('src/a/one.txt'),
      commit('op-a-0001', 'src/a/one.txt'),
      { do: 'context', percentage: 72 },
      { do: 'await_message', contains: 'write_handoff' },
      { do: 'mcp', tool: 'write_handoff', args: handoffArgs('op-a-hand1', 'Add src/a/two.txt') },
      turn,
    ],
    [
      { do: 'mcp', tool: 'get_context', args: {} },
      write('src/a/two.txt'),
      commit('op-a-0002', 'src/a/two.txt'),
      turn,
    ],
  ],
  Beta: [
    [
      { do: 'tool', toolName: 'Bash', input: { command: 'curl -s https://example.com' } },
      {
        do: 'tool',
        toolName: 'AskUserQuestion',
        input: {
          questions: [
            {
              question: 'Which badge color?',
              header: 'Color',
              options: [
                { label: 'Teal', description: '' },
                { label: 'Red', description: '' },
              ],
              multiSelect: false,
            },
          ],
        },
      },
      write('src/b/one.txt'),
      commit('op-b-0001', 'src/b/one.txt'),
      turn,
    ],
  ],
  Gamma: [
    [
      {
        do: 'mcp',
        tool: 'ask_human',
        args: {
          opId: 'op-c-ask01',
          category: 'design',
          question: 'Round or square corners?',
          options: [
            { label: 'Round', description: '' },
            { label: 'Square', description: '' },
          ],
        },
      },
      write('src/c/one.txt'),
      commit('op-c-0001', 'src/c/one.txt'),
      commit('op-c-0001', 'src/c/one.txt'),
      turn,
    ],
  ],
};

/** No real caffeinate and no file watcher in daemon tests that are not about them. */
const QUIET = { caffeinate: () => null, watch: false } as const;

const adapter = new FakeAdapter(BOOK);
let daemon: RunningDaemon;
let repo: TempDir;
let data: TempDir;
let api: ReturnType<typeof apiClient>;

beforeAll(async () => {
  repo = createTempRepo();
  data = tempDir('acceptance');
  daemon = await startDaemon({
    dataDir: data.path,
    port: 0,
    adapter,
    logLevel: 'warn',
    ...QUIET,
  });
  api = apiClient(daemon.url, daemon.token);
});
afterAll(async () => {
  await daemon.stop();
  repo.cleanup();
  data.cleanup();
});

describe('§1.3 with the fake adapter', () => {
  it('runs three tasks through handoff, questions, permissions and verification to DONE', async () => {
    const project = await api.post('/projects', ProjectDto, {
      name: 'acceptance',
      repoPath: repo.path,
      gateCommand: 'test -d src',
      flowId: await quickFlowId(api),
      maxLanes: 3,
      areas: [
        { name: 'a', globs: ['src/a/**'] },
        { name: 'b', globs: ['src/b/**'] },
        { name: 'c', globs: ['src/c/**'] },
      ],
      handoffPct: 70,
      nudgePct: 85,
    });
    const task = (title: string, areas: string[], dependsOn: string[] = []) =>
      api.post(`/projects/${project.id}/tasks`, TaskDto, {
        title,
        acceptanceCriteria: ['files exist'],
        areas,
        dependsOn,
      });
    const alpha = await task('Alpha', ['a']);
    const beta = await task('Beta', ['b']);
    const gamma = await task('Gamma', ['c'], [alpha.id]);
    for (const t of [alpha, beta, gamma]) await api.post(`/tasks/${t.id}/start`, WorkstreamDto);

    const answer = async (kind: string, title: string, choice: string) => {
      const card = await waitForAsync(async () =>
        (await api.get('/inbox?state=OPEN', z.array(InboxItemDto))).find(
          (i) => i.kind === kind && i.title.includes(title),
        ),
      );
      await api.post(`/inbox/${card.id}/answer`, z.unknown(), { choice });
    };
    await answer('permission', 'Bash', 'allow_once');
    await answer('question', 'badge color', 'Teal');
    await answer('question', 'corners', 'Round');

    const all = await waitForAsync(async () => {
      const list = await api.get('/workstreams?active=false', z.array(WorkstreamDto));
      return list.length === 3 && list.every((w) => w.state === 'DONE') ? list : undefined;
    }, 30_000);

    const alphaWs = all.find((w) => w.taskId === alpha.id);
    if (!alphaWs) throw new Error('no Alpha workstream');
    expect(listSessions(daemon.state.db, alphaWs.id)).toHaveLength(2);
    for (const ws of all) {
      expect(
        listEvidence(daemon.state.db, ws.id)
          .filter((e) => e.kind === 'gate')
          .at(-1)?.exitCode,
      ).toBe(0);
    }

    const trailers = execFileSync(
      'git',
      ['-C', repo.path, 'log', '--format=%(trailers:key=10db-Op,valueonly)'],
      { env: isolatedGitEnv() },
    )
      .toString()
      .split('\n')
      .filter(Boolean);
    expect(trailers.length).toBe(new Set(trailers).size);
    expect(trailers.filter((t) => t === 'op-c-0001')).toHaveLength(1);
    // The retried commit succeeds and returns the original result rather than failing on an empty diff.
    const gammaCommits = adapter.observations.filter(
      (o) => o.title === 'Gamma' && o.kind === 'mcp_result' && o.detail['tool'] === 'commit',
    );
    expect(gammaCommits.map((o) => o.detail['isError'])).toEqual([false, false]);
    expect(gammaCommits[1]?.detail['text']).toBe(gammaCommits[0]?.detail['text']);

    // Each inbox answer took effect in the session that asked.
    const seen = (title: string, kind: string) =>
      adapter.observations.filter((o) => o.title === title && o.kind === kind);
    expect(seen('Beta', 'tool_denied')).toEqual([]);
    expect(seen('Beta', 'tool_allowed').map((o) => o.detail['toolName'])).toEqual(
      expect.arrayContaining(['Bash', 'AskUserQuestion']),
    );
    expect(
      JSON.stringify(
        seen('Beta', 'tool_allowed').find((o) => o.detail['toolName'] === 'AskUserQuestion')
          ?.detail['answers'],
      ),
    ).toContain('Teal');
    const asked = seen('Gamma', 'mcp_result').find((o) => o.detail['tool'] === 'ask_human');
    expect(String(asked?.detail['text'])).toContain('Round');

    const decisions = daemon.state.db.select().from(schema.decisions).all();
    expect(decisions.map((d) => d.choice)).toContain('Round');
  }, 60_000);

  it('replays the full history after a cursor, as a reopened window would', async () => {
    const events = await api.get('/events?after=0&limit=1000', z.array(DaemonEvent));
    const middle = events[Math.floor(events.length / 2)]?.seq ?? 0;
    const last = events.at(-1)?.seq;
    const received: number[] = [];
    const socket = new WebSocket(
      `${daemon.url.replace('http', 'ws')}/events/stream?after=${String(middle)}&token=${daemon.token}`,
    );
    await new Promise<void>((resolve, reject) => {
      socket.onmessage = (m) => {
        received.push(DaemonEvent.parse(JSON.parse(String(m.data))).seq);
        if (received.at(-1) === last) resolve();
      };
      socket.onerror = () => {
        reject(new Error('socket error'));
      };
    });
    socket.close();
    expect(received).toEqual(events.filter((e) => e.seq > middle).map((e) => e.seq));
  }, 30_000);
});
