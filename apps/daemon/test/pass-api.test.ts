import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  mintId,
  PASS_SIGN_OFF_CHOICE,
  ProjectDto,
  TaskDto,
  WorkstreamChangesDto,
  type PassCheckDetail,
} from '@10db/contracts';
import {
  endPassTurn,
  getInboxItem,
  getWorkstreamRow,
  insertInboxItem,
  insertPass,
  insertPassTurn,
  insertWorkstream,
  listEvidence,
  patchWorkstream,
  setPassTurnKept,
  settlePassTurn,
  transitionWorkstream,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { RunningDaemon } from '../src/daemon';
import { FakeAdapter } from '../src/sessions';
import { apiClient } from './api-client';
import { createTempRepo, isolatedGitEnv, tempDir } from './fixtures';
import { startDaemonWithProfiles } from './daemon-with-profiles';

// Workbench spec §6.1: a pass page is never approved or sent back; its Ready item answers only with
// Sign Off, and what the builder is shown is the turn's kept commit.

let data: { path: string; cleanup(): void };
let repo: { path: string; cleanup(): void };
let daemon: RunningDaemon;
beforeEach(async () => {
  data = tempDir('pass api');
  repo = createTempRepo();
  daemon = await startDaemonWithProfiles({
    sandbox: null,
    dataDir: data.path,
    port: 0,
    adapter: new FakeAdapter({}),
    logLevel: 'debug',
    caffeinate: () => null,
    watch: false,
    // A tick long enough that nothing starts while the test looks.
    tickMs: 3_600_000,
  });
});
afterEach(async () => {
  await daemon.stop();
  repo.cleanup();
  data.cleanup();
});

const api = () => apiClient(daemon.url, daemon.token);
const rawGit = (...args: string[]) =>
  execFileSync('git', ['-C', repo.path, ...args], {
    env: isolatedGitEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
    .toString()
    .trim();

async function post(path: string, body: unknown) {
  const res = await fetch(`${daemon.url}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${daemon.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: z.unknown().parse(await res.json()) };
}

/** A commit of `path` off HEAD that no branch names, as a turn's kept commit is. */
function keptCommit(path: string, content: string): string {
  const file = join(repo.path, path);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, content);
  rawGit('add', path);
  const tree = rawGit('write-tree');
  rawGit('rm', '-q', '--cached', path);
  return rawGit('commit-tree', '--no-gpg-sign', tree, '-p', 'HEAD', '-m', 'kept');
}

/**
 * A page of an open pass whose first turn has ended Ready: the workstream waits on its `check` item,
 * whose only option is Sign Off and whose detail names the turn's kept commit.
 */
async function readyPage() {
  const project = await api().post('/projects', ProjectDto, {
    name: 'demo',
    repoPath: repo.path,
    gateCommand: null,
    areas: [{ name: 'settings', globs: ['src/settings/**'], role: 'page', route: '/settings' }],
  });
  const task = await api().post(`/projects/${project.id}/tasks`, TaskDto, {
    title: 'Settings: tidy the form',
    acceptanceCriteria: ['x'],
    areas: ['settings'],
    dependsOn: [],
  });
  const startSha = rawGit('rev-parse', 'HEAD');
  const keptSha = keptCommit('src/settings/page.tsx', 'tidied\n');
  return daemon.state.write((ctx) => {
    const { pass, batch } = insertPass(ctx, {
      id: mintId('Pass'),
      projectId: project.id,
      name: 'Polish',
      pageCap: 4,
      returnBranch: 'main',
      startSha,
      branch: '10db/polish-abcdef',
      baseBranch: 'main',
      repo: null,
      taskIds: [task.id],
      dirt: [],
    });
    const ws = insertWorkstream(ctx, task.id, {
      batchId: batch.id,
      first: { model: 'claude-sonnet-5-5', effort: 'medium' },
    });
    for (const to of ['STARTING', 'RUNNING'] as const)
      transitionWorkstream(ctx, ws.id, { to, fence: null });
    const turn = insertPassTurn(ctx, {
      taskId: task.id,
      workstreamId: ws.id,
      sessionId: null,
      messageId: null,
    });
    endPassTurn(ctx, turn.id, { ending: 'ready', replyBody: 'Tidied the form.' });
    setPassTurnKept(ctx, turn.id, { keptSha, keptBaseSha: startSha, sharedSeq: null });
    settlePassTurn(ctx, turn.id);
    const detail: PassCheckDetail = {
      passId: pass.id,
      taskId: task.id,
      workstreamId: ws.id,
      turnId: turn.id,
      keptSha,
      keptBaseSha: startSha,
      turnFiles: [{ path: 'src/settings/page.tsx', added: 1, removed: 0 }],
      pageFiles: [{ path: 'src/settings/page.tsx', added: 1, removed: 0 }],
    };
    const item = insertInboxItem(ctx, {
      projectId: project.id,
      kind: 'check',
      title: `Ready: ${task.title}`,
      body: 'The page is ready to look at.',
      options: [{ label: PASS_SIGN_OFF_CHOICE, description: 'The page is right' }],
      recommendation: null,
      category: 'product',
      urgency: 'normal',
      detail,
      foldKey: null,
      targets: [{ workstreamId: ws.id, sessionId: null }],
    });
    transitionWorkstream(ctx, ws.id, {
      to: 'WAITING_HUMAN',
      fence: null,
      patch: { nextAction: { kind: 'pass_review', inboxId: item.id } },
    });
    return { project, task, pass, ws, item, keptSha, startSha };
  });
}

describe('a Ready pass page', () => {
  it.each([
    { name: 'Approve', answer: { choice: 'approve' }, status: 400 },
    { name: 'Send Back', answer: { choice: 'send_back', note: 'Bigger' }, status: 400 },
    {
      name: 'Sign Off, until closing lands',
      answer: { choice: PASS_SIGN_OFF_CHOICE },
      status: 409,
    },
  ])('refuses $name and leaves the page as it was', async ({ answer, status }) => {
    const page = await readyPage();
    const before = getWorkstreamRow(daemon.state.db, page.ws.id);

    const res = await post(`/inbox/${page.item.id}/answer`, answer);

    expect(res.status).toBe(status);
    const after = getWorkstreamRow(daemon.state.db, page.ws.id);
    expect(after).toMatchObject({
      state: 'WAITING_HUMAN',
      attempt: before.attempt,
      nextAction: { kind: 'pass_review', inboxId: page.item.id },
    });
    expect(listEvidence(daemon.state.db, page.ws.id)).toEqual([]);
    expect(getInboxItem(daemon.state.db, page.item.id).state).toBe('OPEN');
  });

  it("an answer to the lane's earlier question leaves the page waiting for the builder's message", async () => {
    const page = await readyPage();
    const question = daemon.state.write((ctx) =>
      insertInboxItem(ctx, {
        projectId: page.project.id,
        kind: 'question',
        title: 'Which label?',
        body: 'Which label should the button have?',
        options: [],
        recommendation: null,
        category: 'product',
        urgency: 'normal',
        detail: null,
        foldKey: null,
        targets: [{ workstreamId: page.ws.id, sessionId: null }],
      }),
    );

    const res = await post(`/inbox/${question.id}/answer`, { choice: 'Save' });

    expect(res.status).toBe(200);
    expect(getWorkstreamRow(daemon.state.db, page.ws.id)).toMatchObject({
      state: 'WAITING_HUMAN',
      nextAction: { kind: 'pass_review', inboxId: page.item.id },
    });
  });

  it("shows the turn's kept commit against the pass branch tip it was kept on, with no commits", async () => {
    const page = await readyPage();
    daemon.state.write((ctx) => {
      patchWorkstream(ctx, page.ws.id, null, { baseHead: page.startSha });
    });
    // The folder moves on after the page was Ready; what is shown is still the kept commit.
    writeFileSync(join(repo.path, 'later.txt'), 'later\n');
    rawGit('add', 'later.txt');
    rawGit('commit', '-q', '-m', 'later');

    const changes = await api().get(`/workstreams/${page.ws.id}/changes`, WorkstreamChangesDto);

    expect(changes).toMatchObject({
      baseHead: page.startSha,
      head: page.keptSha,
      commits: [],
      files: [{ path: 'src/settings/page.tsx', added: 1, removed: 0 }],
    });
    expect(changes.diff).toContain('+tidied');
  });
});
