import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCommand, httpApi, type CommandDeps } from '@10db/agent-skill';
import { ProjectDto, TaskDto } from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { RunningDaemon } from '../src/daemon';
import { FakeAdapter } from '../src/sessions';
import { apiClient } from './api-client';
import { createTempRepo, isolatedGitEnv, tempDir, type TempDir } from './fixtures';
import { startDaemonWithProfiles } from './daemon-with-profiles';

const VERSION = '0123456789ab';

let data: TempDir;
let home: TempDir;
let shipped: TempDir;
let repo: TempDir;
let scratch: TempDir;
let daemon: RunningDaemon;
let api: ReturnType<typeof apiClient>;
let project: ProjectDto;

// A temp builderHome and a placement that installs nothing keep the daemon off the real home, while the
// shipped version still turns the skill's version check on.
beforeEach(async () => {
  data = tempDir('skill api data');
  home = tempDir('skill api home');
  shipped = tempDir('skill api shipped');
  repo = createTempRepo();
  scratch = tempDir('skill api files');
  writeFileSync(join(shipped.path, 'VERSION'), `${VERSION}\n`);
  daemon = await startDaemonWithProfiles({
    sandbox: null,
    dataDir: data.path,
    port: 0,
    adapter: new FakeAdapter({}),
    logLevel: 'warn',
    caffeinate: () => null,
    watch: false,
    builderHome: home.path,
    agentSkill: { kind: 'not_installable', reason: 'other_data_dir', shippedDir: shipped.path },
  });
  api = apiClient(daemon.url, daemon.token);
  project = await api.post('/projects', ProjectDto, {
    name: 'demo',
    repoPath: realpathSync(repo.path),
    gateCommand: 'make gate',
    areas: [{ name: 'src', globs: ['src/**'] }],
  });
});
afterEach(async () => {
  await daemon.stop();
  for (const dir of [data, home, shipped, repo, scratch]) dir.cleanup();
});

/** The skill's commands over the daemon's real HTTP, with the repo as the working directory. */
function skill(version: string = VERSION) {
  const lines: string[] = [];
  const deps: CommandDeps = {
    api: httpApi({ base: daemon.url, token: daemon.token }, version),
    out: (line) => lines.push(line),
    cwd: repo.path,
    git: (args, cwd) => {
      try {
        return execFileSync('git', [...args], {
          cwd,
          encoding: 'utf8',
          env: isolatedGitEnv(),
          stdio: ['ignore', 'pipe', 'ignore'],
        });
      } catch {
        return null;
      }
    },
    readFile: (path) => readFileSync(path, 'utf8'),
    realpath: (path) => realpathSync(path),
  };
  return { lines, run: (...argv: string[]) => runCommand(argv, deps) };
}

function file(name: string, content: unknown): string {
  mkdirSync(scratch.path, { recursive: true });
  const path = join(scratch.path, name);
  writeFileSync(path, JSON.stringify(content));
  return path;
}

const draft = (title: string, extra: Record<string, unknown> = {}) => ({
  title,
  why: 'It matters to the builder.',
  acceptanceCriteria: ['It holds'],
  areas: ['src'],
  ...extra,
});

async function createTwoTasks() {
  const s = skill();
  await s.run('create', project.id, file('a.json', draft('First')));
  const [first] = await api.get(`/projects/${project.id}/tasks`, z.array(TaskDto));
  if (!first) throw new Error('no first task');
  await s.run('create', project.id, file('b.json', draft('Second', { dependsOn: [first.id] })));
  const tasks = await api.get(`/projects/${project.id}/tasks`, z.array(TaskDto));
  const second = tasks.find((t) => t.title === 'Second');
  if (!second) throw new Error('no second task');
  return { first, second };
}

describe('the 10db-task skill against the real daemon', () => {
  it('create posts a task the daemon lists with its dependsOn, and context shows the dependency', async () => {
    const { first, second } = await createTwoTasks();
    expect(second.dependsOn).toEqual([first.id]);

    const s = skill();
    await s.run('context');
    const out = z
      .object({
        matched: z.number(),
        skillVersion: z.string().nullable(),
        projects: z.array(
          z.object({
            openTasks: z.array(z.object({ id: z.string(), dependsOn: z.array(z.string()) })),
          }),
        ),
      })
      .parse(JSON.parse(s.lines.join('\n')));
    expect(out.matched).toBe(1);
    expect(out.skillVersion).toBe(VERSION);
    expect(out.projects[0]?.openTasks.find((t) => t.id === second.id)?.dependsOn).toEqual([
      first.id,
    ]);
  });

  it('project prints the gate command and base branch', async () => {
    const s = skill();
    await s.run('project', 'demo');
    expect(JSON.parse(s.lines.join('\n'))).toMatchObject({
      gate: { command: 'make gate' },
      baseBranch: 'main',
    });
  });
});
