import type { ProjectDto } from '@10db/contracts';
import {
  createTestStore,
  getProject,
  listInbox,
  patchProject,
  seedProject,
  type Store,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { createInboxService, type InboxService } from '../inbox';
import { silentLogger } from '../log';
import type { GateRequest, GateResult, GateRunner } from '../verify';
import { autoDocker } from './auto-docker';

let close: () => void;
let store: Store;
let state: StateStore;
let inbox: InboxService;
let project: ProjectDto;
let seen: GateRequest[];
let results: GateResult[];
let base: Record<string, string>;

const ok: GateResult = {
  exitCode: 0,
  durationMs: 1,
  tail: 'GATE PASS',
  logPath: '/log',
  timedOut: false,
  aborted: false,
  blockedHosts: [],
};
const refused: GateResult = {
  ...ok,
  exitCode: 125,
  tail: "10db: Docker isn't available to sandboxed gates",
  dockerRefused: true,
};

beforeEach(() => {
  ({ store, close } = createTestStore());
  state = createStateStore(store, createEventBus());
  inbox = createInboxService({ state, onParkedAnswer: () => undefined });
  project = seedProject(store);
  seen = [];
  results = [ok];
  base = {};
});
afterEach(() => {
  close();
});

const runner: GateRunner = {
  run(request) {
    seen.push(request);
    return Promise.resolve(results[Math.min(seen.length, results.length) - 1] ?? ok);
  },
};

const wrapped = () =>
  autoDocker(runner, {
    state,
    inbox,
    logger: silentLogger,
    readBase: (_repo, _ref, path) => Promise.resolve(base[path] ?? null),
  });

function request(command: string, extra: Partial<GateRequest['project']> = {}): GateRequest {
  return {
    project: { id: project.id, repoPath: '/repo', sandboxLoopback: false, ...extra },
    command,
    logPath: '/log',
    timeoutMs: 1000,
    env: {},
    rules: [],
    checkouts: [],
    beforeStart: () => Promise.resolve(true),
  };
}

const notes = () => listInbox(state.db).filter((item) => item.title.startsWith('Docker is on'));

describe('a gate for a project with Docker on', () => {
  it('runs with the switch on, whatever switch the request was built from', async () => {
    store.write((ctx) => patchProject(ctx, project.id, { sandboxDocker: true }));
    await wrapped().run(request('make gate', { sandboxDocker: false }));
    expect(seen.map((r) => r.project.sandboxDocker)).toEqual([true]);
    expect(notes()).toEqual([]);
  });
});

describe('a gate that is seen to call docker', () => {
  it('turns Docker on before it runs, leaves one note saying why, and runs once', async () => {
    base['Makefile'] = 'gate:\n\tdocker compose exec -T backend pytest\n';
    const result = await wrapped().run(request('make gate'));
    expect(result).toBe(ok);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.project.sandboxDocker).toBe(true);
    expect(getProject(state.db, project.id).sandboxDocker).toBe(true);
    expect(notes()).toHaveLength(1);
    expect(notes()[0]?.body).toContain('calls docker');
  });

  it('does not turn it on from a command that calls nothing', async () => {
    base['Makefile'] = 'gate:\n\tpnpm test\n';
    await wrapped().run(request('make gate'));
    expect(seen[0]?.project.sandboxDocker).toBe(false);
    expect(getProject(state.db, project.id).sandboxDocker).toBe(false);
    expect(notes()).toEqual([]);
  });

  it('counts a base it cannot read as not calling docker', async () => {
    const failing = autoDocker(runner, {
      state,
      inbox,
      logger: silentLogger,
      readBase: () => Promise.reject(new Error('no such ref')),
    });
    await failing.run(request('make gate'));
    expect(seen).toHaveLength(1);
    expect(getProject(state.db, project.id).sandboxDocker).toBe(false);
  });
});

describe('a gate that fails because Docker was refused', () => {
  const needed = () => listInbox(state.db).filter((item) => item.title.includes('may need Docker'));

  it('leaves the switch off, runs once and answers the failed result', async () => {
    results = [refused, ok];
    const result = await wrapped().run(request('pnpm test'));
    expect(result).toBe(refused);
    expect(seen.map((r) => r.project.sandboxDocker)).toEqual([false]);
    expect(getProject(state.db, project.id).sandboxDocker).toBe(false);
    expect(notes()).toEqual([]);
  });

  it('leaves one note saying the gate asked for Docker and pointing to the Settings switch', async () => {
    results = [refused];
    await wrapped().run(request('pnpm test'));
    expect(needed()).toHaveLength(1);
    expect(needed()[0]?.body).toContain('Settings');
    expect(needed()[0]?.body).toContain('asked for Docker');
  });

  it('adds no second note for a second refusal', async () => {
    results = [refused];
    await wrapped().run(request('pnpm test'));
    await wrapped().run(request('pnpm test'));
    expect(needed()).toHaveLength(1);
  });

  it('leaves the failure alone, with no note, when the builder turned Docker off', async () => {
    store.write((ctx) => patchProject(ctx, project.id, { sandboxDocker: false }));
    results = [refused];
    const result = await wrapped().run(request('pnpm test'));
    expect(result).toBe(refused);
    expect(seen).toHaveLength(1);
    expect(getProject(state.db, project.id).sandboxDocker).toBe(false);
    expect(notes()).toEqual([]);
    expect(needed()).toEqual([]);
  });

  it('leaves no note for a gate that passed, was stopped or timed out', async () => {
    results = [{ ...refused, exitCode: 0 }];
    await wrapped().run(request('pnpm test'));
    results = [{ ...refused, aborted: true }];
    await wrapped().run(request('pnpm test'));
    results = [{ ...refused, timedOut: true }];
    await wrapped().run(request('pnpm test'));
    expect(getProject(state.db, project.id).sandboxDocker).toBe(false);
    expect(notes()).toEqual([]);
    expect(needed()).toEqual([]);
  });

  it('leaves no note for a gate that failed without a refused docker', async () => {
    results = [{ ...ok, exitCode: 1 }];
    await wrapped().run(request('pnpm test'));
    expect(needed()).toEqual([]);
  });

  it('runs a lane-written docker call without turning the switch on', async () => {
    // The base shows nothing; the lane's own test is what ran docker.
    base['Makefile'] = 'gate:\n\tpnpm test\n';
    results = [refused];
    await wrapped().run(request('make gate'));
    expect(seen).toHaveLength(1);
    expect(getProject(state.db, project.id).sandboxDocker).toBe(false);
  });
});

describe('where the base is read from', () => {
  it('reads origin/<base> only, never the local base branch', async () => {
    const refs: string[] = [];
    const reading = autoDocker(runner, {
      state,
      inbox,
      logger: silentLogger,
      readBase: (_repo, ref, path) => {
        refs.push(ref);
        // A file only the local branch has, as a lane commits to it in a local-delivery project.
        return Promise.resolve(
          ref === project.baseBranch && path === 'Makefile'
            ? 'gate:\n\tdocker compose run t\n'
            : null,
        );
      },
    });
    await reading.run(request('make gate'));
    expect(refs.length).toBeGreaterThan(0);
    expect(new Set(refs)).toEqual(new Set([`origin/${project.baseBranch}`]));
    expect(getProject(state.db, project.id).sandboxDocker).toBe(false);
    expect(notes()).toEqual([]);
  });

  it('still turns Docker on for a file the committed origin base has', async () => {
    const reading = autoDocker(runner, {
      state,
      inbox,
      logger: silentLogger,
      readBase: (_repo, ref, path) =>
        Promise.resolve(
          ref === `origin/${project.baseBranch}` && path === 'Makefile'
            ? 'gate:\n\tdocker compose run t\n'
            : null,
        ),
    });
    await reading.run(request('make gate'));
    expect(seen[0]?.project.sandboxDocker).toBe(true);
    expect(notes()).toHaveLength(1);
  });
});

describe('a gate with no project of its own', () => {
  it('runs as it was asked', async () => {
    results = [refused];
    const asked: GateRequest = {
      ...request('pnpm install'),
      project: { repoPath: '/wt', sandboxLoopback: false },
    };
    expect(await wrapped().run(asked)).toBe(refused);
    expect(seen).toEqual([asked]);
  });
});
