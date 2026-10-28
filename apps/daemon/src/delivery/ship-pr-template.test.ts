import { execFileSync } from 'node:child_process';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getBatch, listWorkstreams } from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { createDeliveryHarness, type DeliveryHarness } from '../../test/delivery-harness';
import { isolatedGitEnv, tempDir, type TempDir } from '../../test/fixtures';

const SECRET = 'NOT FOR THE PULL REQUEST 7f3a';

let h: DeliveryHarness;
let outside: TempDir;
afterEach(() => {
  h.close();
  outside.cleanup();
});

/** git in the checkout the batch is built in, as a lane's commits would land there. */
function gitIn(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { env: isolatedGitEnv(), stdio: 'pipe' })
    .toString()
    .trim();
}

/** A file outside every checkout, as a lane would point a link at it. */
function secretFile(): string {
  const file = join(outside.path, 'secret.md');
  writeFileSync(file, `## Notes\n\n${SECRET}\n`);
  return file;
}

describe.each(['shared', 'worktree'] as const)('the PR template in %s mode', (mode) => {
  /** Starts one task, lets `plant` commit in its checkout, finishes it and ships; returns the PR body. */
  async function shipped(plant: (checkout: string) => void): Promise<string> {
    h = createDeliveryHarness({ workspaceMode: mode }, { trigger: false });
    outside = tempDir('outside');
    const started = h.starter.startTask(h.addTask('Alpha').id);
    await h.jobs.idle();
    const batch = getBatch(h.store.db, started.id);
    const checkout = batch.worktreePath ?? h.repo;
    mkdirSync(join(checkout, 'src', 'api'), { recursive: true });
    writeFileSync(join(checkout, 'src', 'api', 'alpha.txt'), 'alpha\n');
    gitIn(checkout, 'add', 'src/api/alpha.txt');
    plant(checkout);
    gitIn(checkout, 'commit', '-q', '-m', 'Add alpha');
    h.settle(h.only(listWorkstreams(h.store.db, { batchId: batch.id })).id, 'DONE');
    h.shipper.checkBatch(batch.id);
    await h.jobs.idle();
    const now = getBatch(h.store.db, batch.id);
    expect(now.state).toBe('SHIPPED');
    return h.gh.body(now.prUrl ?? '');
  }

  it.each<{ name: string; plant: (checkout: string) => void; filled: boolean }>([
    {
      name: 'a committed regular template fills',
      plant: (checkout) => {
        mkdirSync(join(checkout, '.github'), { recursive: true });
        writeFileSync(
          join(checkout, '.github', 'pull_request_template.md'),
          '## Checklist\n\n- [ ] the template was read\n',
        );
        gitIn(checkout, 'add', '.github/pull_request_template.md');
      },
      filled: true,
    },
    {
      name: 'a template that is a link to a file outside is no template',
      plant: (checkout) => {
        mkdirSync(join(checkout, '.github'), { recursive: true });
        symlinkSync(secretFile(), join(checkout, '.github', 'pull_request_template.md'));
        gitIn(checkout, 'add', '.github/pull_request_template.md');
      },
      filled: false,
    },
    {
      name: 'a .github that is a link to a directory outside is no template',
      plant: (checkout) => {
        mkdirSync(join(outside.path, 'github'));
        writeFileSync(
          join(outside.path, 'github', 'pull_request_template.md'),
          `## Notes\n\n${SECRET}\n`,
        );
        symlinkSync(join(outside.path, 'github'), join(checkout, '.github'));
        gitIn(checkout, 'add', '.github');
      },
      filled: false,
    },
    {
      name: 'a template over 64 KiB is no template',
      plant: (checkout) => {
        mkdirSync(join(checkout, '.github'), { recursive: true });
        writeFileSync(
          join(checkout, '.github', 'pull_request_template.md'),
          `## Checklist\n\n${SECRET}\n${'x'.repeat(64 * 1024)}\n`,
        );
        gitIn(checkout, 'add', '.github/pull_request_template.md');
      },
      filled: false,
    },
  ])('$name', async ({ plant, filled }) => {
    const body = await shipped(plant);
    expect(body).not.toContain(SECRET);
    if (filled) expect(body).toContain('- [ ] the template was read');
    else expect(body).not.toContain('## Checklist');
  });
});
