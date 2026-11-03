import { globSync } from 'node:fs';
import { matchesGlob, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { repoRoot } from './workspace';

// The daemon's delivery tests each build real git repositories and drive pushes, worktrees and
// gates: 7 to 10 s alone, 3 to 8 times that under a busy gate, so seven passed vitest's 30 s limit
// in one run and the gate failed for whichever lane ran it. They run as their own project: capped
// in workers, and after every other project has finished, so they never compete with the suites that
// start at the same time.

const Project = z.object({
  default: z.object({
    test: z.object({
      name: z.string(),
      include: z.array(z.string()).default(['**/*.test.ts']),
      exclude: z.array(z.string()).default([]),
      maxWorkers: z.number().optional(),
      testTimeout: z.number().optional(),
      hookTimeout: z.number().optional(),
      sequence: z.object({ groupOrder: z.number().default(0) }).default({ groupOrder: 0 }),
    }),
  }),
});
type Project = z.infer<typeof Project>['default']['test'];

const daemonRoot = resolve(repoRoot, 'apps/daemon');

/** A project config by file name; the full name keeps Vite from reading `.config` as an extension. */
async function load(file: string): Promise<Project> {
  const path = resolve(daemonRoot, file);
  return Project.parse(await import(path)).default.test;
}

const daemon = await load('vitest.config.ts');
const delivery = await load('vitest.delivery.config.ts');
const DEFAULT_EXCLUDE = ['**/node_modules/**', '**/dist/**'];

/** Whether a project runs the file (relative to apps/daemon): it matches an include and no exclude. */
function runs(project: Project, file: string): boolean {
  return (
    project.include.some((pattern) => matchesGlob(file, pattern)) &&
    ![...DEFAULT_EXCLUDE, ...project.exclude].some((pattern) => matchesGlob(file, pattern))
  );
}

describe('the daemon test projects', () => {
  const files = globSync('{src,test}/**/*.test.ts', { cwd: daemonRoot, exclude: ['node_modules'] });

  it('run every daemon test file exactly once', () => {
    expect(files.length).toBeGreaterThan(100);
    const wrong = files.filter(
      (file) => [daemon, delivery].filter((p) => runs(p, file)).length !== 1,
    );
    expect(wrong).toEqual([]);
  });

  it('give the delivery project every file under src/delivery, and no other', () => {
    const delivered = files.filter((file) => runs(delivery, file));
    expect(delivered.length).toBeGreaterThan(30);
    expect(delivered.filter((file) => !file.startsWith('src/delivery/'))).toEqual([]);
    expect(
      files.filter((file) => file.startsWith('src/delivery/') && !runs(delivery, file)),
    ).toEqual([]);
  });

  it('cap the delivery workers and run them after the other projects', () => {
    expect(delivery.name).not.toBe(daemon.name);
    expect(delivery.maxWorkers).toBeGreaterThanOrEqual(1);
    expect(delivery.maxWorkers).toBeLessThanOrEqual(4);
    expect(delivery.sequence.groupOrder).toBeGreaterThan(daemon.sequence.groupOrder);
  });

  it('give the delivery tests more than 30 s, the limit they pass under load', () => {
    expect(delivery.testTimeout).toBeGreaterThan(30_000);
    expect(delivery.hookTimeout).toBeGreaterThan(30_000);
  });
});
