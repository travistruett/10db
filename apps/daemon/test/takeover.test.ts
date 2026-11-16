import { execFileSync } from 'node:child_process';
import {
  BatchDto,
  ConversationOwnerKind,
  ConversationProfile,
  ConversationState,
  mintId,
  ProjectDto,
  ProjectViewDto,
  TaskDto,
  type BatchId,
  type ProjectId,
} from '@10db/contracts';
import { getBatchRow, getChat, insertChat, insertConversation, patchBatch } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { RunningDaemon } from '../src/daemon';
import { FakeAdapter, type FakeScriptBook } from '../src/sessions';
import { apiClient } from './api-client';
import { startDaemonWithProfiles } from './daemon-with-profiles';
import { FakeGh } from './fake-gh';
import {
  createTempRepoWithOrigin,
  githubOrigin,
  isolatedGitEnv,
  NETWORK_ENV,
  tempDir,
  waitForAsync,
} from './fixtures';

// Sessions spec §7.5: a chat in the builder's terminal holds Your folder across 10db's quit and restart, and
// 10db's own git work that waits for it stops with 10db and goes on at the next start.

const BOOK: FakeScriptBook = {
  Alpha: [
    [
      { do: 'tool', toolName: 'Write', input: { file_path: 'src/api/alpha.txt', content: 'a\n' } },
      {
        do: 'mcp',
        tool: 'commit',
        args: { opId: 'op-alpha-0001', paths: ['src/api/alpha.txt'], message: 'Add alpha' },
      },
      { do: 'turn_complete' },
    ],
  ],
};

let data: { path: string; cleanup(): void };
let remote: ReturnType<typeof createTempRepoWithOrigin>;
let network: ReturnType<typeof githubOrigin>;
let gh: FakeGh;
let daemon: RunningDaemon | null = null;
beforeEach(() => {
  data = tempDir('takeover-daemon');
  remote = createTempRepoWithOrigin();
  network = githubOrigin(remote.repo.path, remote.origin.path);
  gh = new FakeGh();
});
afterEach(async () => {
  await daemon?.stop();
  daemon = null;
  remote.cleanup();
  network.cleanup();
  data.cleanup();
});

const git = (...args: string[]): string =>
  execFileSync('git', ['-C', remote.repo.path, ...args], { env: isolatedGitEnv() })
    .toString()
    .trim();

/** Starts a daemon on the test's data dir; a call after `daemon.stop()` is a restart. */
async function boot(): Promise<RunningDaemon> {
  daemon = await startDaemonWithProfiles({
    sandbox: null,
    dataDir: data.path,
    port: 0,
    adapter: new FakeAdapter(BOOK),
    logLevel: 'warn',
    caffeinate: () => null,
    watch: false,
    gh,
    networkEnv: () => ({ ...NETWORK_ENV, GIT_CONFIG_GLOBAL: network.global }),
  });
  return daemon;
}

/** The line a batch's wait notice reads, if it has one. */
const waitLine = (running: RunningDaemon, batchId: BatchId): string | null =>
  getBatchRow(running.state.db, batchId).notices.find((n) => n.key === 'folder-hold')?.line ?? null;

function takenOverChat(running: RunningDaemon, projectId: ProjectId, title: string) {
  return running.state.write((ctx) => {
    const id = mintId('Chat');
    const conv = insertConversation(ctx, {
      projectId,
      owner: { kind: ConversationOwnerKind.Chat, id },
      profile: ConversationProfile.Explore,
      state: ConversationState.TakenOver,
    });
    return insertChat(ctx, { id, projectId, conversationId: conv.id, title, tabPosition: 0 }).id;
  });
}

describe('a restart with a chat in your terminal', () => {
  it('waits for it, stops with 10db, and switches the checkout back after Hand Back', async () => {
    const first = await boot();
    const api = apiClient(first.url, first.token);
    const project = await api.post('/projects', ProjectDto, {
      name: 'shop',
      repoPath: remote.repo.path,
      gateCommand: 'true',
      defaultRigor: 'light',
      areas: [{ name: 'api', globs: ['src/api/**'] }],
      delivery: 'pull_request',
      prTitlePrefix: 'feat(app)',
    });
    const task = await api.post(`/projects/${project.id}/tasks`, TaskDto, {
      title: 'Alpha',
      acceptanceCriteria: ['it exists'],
      areas: ['api'],
    });
    const [started] = await api.post(`/projects/${project.id}/batches`, z.tuple([BatchDto]), {
      title: 'Greetings',
      taskIds: [task.id],
    });
    const batchId = started.id;
    await waitForAsync(async () => {
      const view = (await api.get('/projects', z.array(ProjectViewDto))).find(
        (p) => p.id === project.id,
      );
      return view?.currentBatch?.state === 'SHIPPED' ? view.currentBatch : undefined;
    }, 60_000);
    await waitForAsync(
      () => Promise.resolve(getBatchRow(first.state.db, batchId).returnSha === null),
      30_000,
    );
    const branch = getBatchRow(first.state.db, batchId).branch;
    if (branch === null) throw new Error('the batch has no branch');
    const home = git('rev-parse', 'HEAD');

    // Put the checkout where a daemon that stopped between the end and the switch back leaves it: on the
    // batch's branch, with the place still set, and a chat in the builder's terminal.
    if (git('branch', '--list', branch) === '') git('branch', branch, home);
    git('switch', '-q', branch);
    first.state.write((ctx) => {
      patchBatch(ctx, batchId, { returnBranch: 'main', returnSha: home });
    });
    const terminal = takenOverChat(first, project.id, 'In terminal');
    await first.stop();

    const second = await boot();
    await waitForAsync(() => Promise.resolve(waitLine(second, batchId) ?? undefined), 30_000).then(
      (line) => {
        expect(line).toBe(
          'Waits for the chat ‘In terminal’ in your terminal to finish with Your folder',
        );
      },
    );
    await second.stop();
    expect(git('branch', '--show-current')).toBe(branch);

    const third = await boot();
    await waitForAsync(() => Promise.resolve(waitLine(third, batchId) ?? undefined), 30_000);
    expect(getBatchRow(third.state.db, batchId).returnSha).toBe(home);
    // Hand Back through the route: the folder is given back and 10db's waiting switch back runs.
    const handBack = await fetch(
      `${third.url}/conversations/${getChat(third.state.db, terminal).conversationId}/hand-back`,
      { method: 'POST', headers: { Authorization: `Bearer ${third.token}` } },
    );
    expect(handBack.status).toBe(204);
    await waitForAsync(
      () => Promise.resolve(git('branch', '--show-current') === 'main' ? true : undefined),
      30_000,
    );
    expect(waitLine(third, batchId)).toBeNull();
  });
});
