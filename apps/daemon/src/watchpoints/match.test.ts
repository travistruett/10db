import { describe, expect, it } from 'vitest';
import {
  effectiveWatchpoints,
  WatchpointFileStatus,
  WatchpointLoudness,
  type Watchpoint,
  type WatchpointFileHit,
} from '@10db/contracts';
import { matchWatchpoints } from './match';

const watchpoint = (key: string, globs: string[], over: Partial<Watchpoint> = {}): Watchpoint => ({
  key,
  label: key,
  why: `why ${key}`,
  globs,
  guidance: `check ${key}`,
  loudness: WatchpointLoudness.Show,
  starter: null,
  ...over,
});

const file = (path: string, over: Partial<WatchpointFileHit> = {}): WatchpointFileHit => ({
  path,
  status: WatchpointFileStatus.Modified,
  added: 3,
  removed: 1,
  patch: `diff --git a/${path} b/${path}\n`,
  clipped: false,
  ...over,
});

const keys = (hits: ReturnType<typeof matchWatchpoints>) => hits.map((h) => h.watchpoint.key);

describe('matchWatchpoints', () => {
  it('matches a glob across dot folders and names', () => {
    const hits = matchWatchpoints(
      [file('.codex/AGENTS.md'), file('.claude/.hidden/rule.md'), file('src/a.ts')],
      [watchpoint('agent', ['**/AGENTS.md', '.claude/**'])],
    );
    expect(hits.map((h) => h.files.map((f) => f.path))).toEqual([
      ['.codex/AGENTS.md', '.claude/.hidden/rule.md'],
    ]);
  });

  it('puts one file under every watchpoint that covers it, and drops a watchpoint nothing hits', () => {
    const hits = matchWatchpoints(
      [file('packages/contracts/prompts/a.ts')],
      [
        watchpoint('contracts', ['**/contracts/**']),
        watchpoint('prompts', ['**/prompts/**']),
        watchpoint('evals', ['**/evals/**']),
      ],
    );
    expect(keys(hits)).toEqual(['contracts', 'prompts']);
  });

  it('keeps a clipped file clipped, and snapshots the watchpoint without its globs', () => {
    const [hit] = matchWatchpoints(
      [file('db/migrations/0001.sql', { patch: '', clipped: true })],
      [watchpoint('migrations', ['**/migrations/**'], { loudness: WatchpointLoudness.Ask })],
    );
    expect(hit?.files[0]?.clipped).toBe(true);
    expect(hit?.watchpoint).toEqual({
      key: 'migrations',
      label: 'migrations',
      why: 'why migrations',
      guidance: 'check migrations',
      loudness: 'ask',
    });
  });
});

describe('effectiveWatchpoints', () => {
  const yours = [
    watchpoint('migrations', ['**/migrations/**']),
    watchpoint('prompts', ['**/prompts/**']),
  ];

  it('lets a project override one of yours by key, add its own, and turn one off', () => {
    const override = watchpoint('migrations', ['db/**'], { why: 'this project' });
    const own = watchpoint('infra', ['infra/**']);
    const list = effectiveWatchpoints(yours, [override, own, { key: 'prompts', off: true }]);
    expect(list.map((f) => [f.key, f.from])).toEqual([
      ['migrations', 'override'],
      ['infra', 'project'],
    ]);
    expect(list[0]?.globs).toEqual(['db/**']);
  });

  it('tags the rest as yours, and ignores an off entry for a key you lack', () => {
    const list = effectiveWatchpoints(yours, [{ key: 'unknown', off: true }]);
    expect(list.map((f) => [f.key, f.from])).toEqual([
      ['migrations', 'you'],
      ['prompts', 'you'],
    ]);
  });
});
