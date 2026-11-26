import { InboxKind, type WorkstreamId } from '@10db/contracts';
import { getWorkstream, listInbox } from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { raiseSkippedCard, SKIPPED_DETAIL } from '../src/delivery';
import { createGit } from '../src/git';
import { silentLogger } from '../src/log';
import type { FakeScriptBook } from '../src/sessions';
import { createTestEngine, type TestEngine } from './engine';

// Every ended unattended run with something new to say raises one item, after a crash, a recovery or
// a retry too, listing every row and what clears each.

type FakeStep = FakeScriptBook[string][number][number];

let engine: TestEngine;
afterEach(async () => {
  await engine.close();
});

const turn: FakeStep = { do: 'turn_complete' };
const bash = (command: string): FakeStep => ({ do: 'tool', toolName: 'Bash', input: { command } });
const write = (path: string): FakeStep => ({
  do: 'tool',
  toolName: 'Write',
  input: { file_path: path, content: 'x' },
});
const commit = (opId: string, paths: string[]): FakeStep => ({
  do: 'mcp',
  tool: 'commit',
  args: { opId, paths, message: 'work' },
});
// Commits a file so the run is DONE: a step with nothing committed is sent back.
const finish = (opId: string): FakeStep[] => [
  write('src/api/a.txt'),
  commit(opId, ['src/api/a.txt']),
  turn,
];

const deps = () => ({ state: engine.state, git: createGit(), log: silentLogger });
const items = () =>
  listInbox(engine.store.db, {}).filter(
    (i) => i.kind === InboxKind.Flag && i.detail?.[SKIPPED_DETAIL] !== undefined,
  );

/** Root config sits in an area of its own, so a task that claims it may commit it. */
const ROOT_CONFIG = { name: 'config', globs: ['.mcp.json', '.vscode/**'] };

async function ended(steps: FakeStep[]): Promise<WorkstreamId> {
  engine = await createTestEngine(
    { Alpha: [steps] },
    {
      areas: [
        { name: 'api', globs: ['src/api/**'] },
        { name: 'ui', globs: ['src/ui/**'] },
        ROOT_CONFIG,
      ],
    },
  );
  const { workstream } = engine.addTask('Alpha', ['api', 'config']);
  engine.launch(workstream.id);
  await engine.runner.idle();
  return workstream.id;
}

describe('Skipped while you were away', () => {
  // A finished task's skips alone raise no item (its drawer lists them); config it wrote still does.
  it('a finished run with two skips and config it wrote raises one item with all of them', async () => {
    const id = await ended([
      bash('curl -s https://a.example'),
      bash('curl -s https://b.example'),
      write('.mcp.json'),
      commit('op-skipped-003', ['.mcp.json']),
      ...finish('op-skipped-001'),
    ]);
    expect(getWorkstream(engine.store.db, id).state).toBe('DONE');
    await raiseSkippedCard(deps(), id);
    await raiseSkippedCard(deps(), id);
    const [item, ...more] = items();
    expect(more).toEqual([]);
    expect(item?.title).toBe('Skipped while you were away: Alpha');
    expect(item?.body).toBe(
      [
        '10db skipped 2 calls this task would have needed you for:',
        "- curl -s https://a.example (This call needs a person's approval on this account, and nobody is watching this task.)",
        "- curl -s https://b.example (This call needs a person's approval on this account, and nobody is watching this task.)",
        '',
        'Config this task wrote, which runs only after you approve it:',
        '- .mcp.json',
      ].join('\n'),
    );
    expect(item?.options.map((o) => o.label)).toEqual(['Run these now', 'Dismiss']);
  });

  it('a finished run with skips but no config raises none', async () => {
    const id = await ended([bash('curl -s https://a.example'), ...finish('op-skipped-002')]);
    await raiseSkippedCard(deps(), id);
    expect(items()).toEqual([]);
  });
});
