import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { judgeShapeCall, type ShapeAccess, type ShapeCall } from './confinement';

// Shape spec §5.2: read-only comes from the tool lists and the hook. Every row here is a call a
// Shape session (or one of its reviewers) must not make.

let root: string;
let access: ShapeAccess;
let dataDir: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), '10db-shape-confine-')));
  const home = join(root, 'home');
  const checkout = join(root, 'checkout');
  const outside = join(root, 'outside');
  dataDir = join(checkout, 'data');
  for (const dir of [
    join(home, '.ssh'),
    checkout,
    join(checkout, 'src'),
    dataDir,
    outside,
    join(root, 'shapes', 'shp_own', 'files'),
    join(root, 'shapes', 'shp_other', 'files'),
    join(root, 'tmp'),
  ])
    mkdirSync(dir, { recursive: true });
  writeFileSync(join(home, '.ssh', 'id_ed25519'), 'secret');
  writeFileSync(join(checkout, 'src', 'a.ts'), 'a');
  writeFileSync(join(dataDir, 'db.sqlite'), 'db');
  writeFileSync(join(outside, 'notes.txt'), 'outside');
  writeFileSync(join(root, 'shapes', 'shp_own', 'files', 'brief.md'), 'brief');
  writeFileSync(join(root, 'shapes', 'shp_other', 'files', 'brief.md'), 'another conversation’s');
  symlinkSync(outside, join(checkout, 'link-out'));
  symlinkSync(join(outside, 'notes.txt'), join(checkout, 'notes-link'));
  access = {
    checkout,
    home,
    protectedReads: [dataDir, join(home, '.ssh')],
    filesDir: join(root, 'shapes', 'shp_own', 'files'),
    tempRoot: join(root, 'tmp'),
  };
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const call = (toolName: string, toolInput: unknown, extra: Partial<ShapeCall> = {}): ShapeCall => ({
  toolName,
  toolInput,
  ...extra,
});
const path = (rel: string): string => join(root, rel);

const REFUSED: readonly (readonly [string, () => ShapeCall])[] = [
  [
    'an Edit',
    () => call('Edit', { file_path: path('checkout/src/a.ts'), old_string: 'a', new_string: 'b' }),
  ],
  ['a Write', () => call('Write', { file_path: path('checkout/new.ts'), content: 'x' })],
  ['a NotebookEdit', () => call('NotebookEdit', { notebook_path: path('checkout/n.ipynb') })],
  ['a Bash call', () => call('Bash', { command: 'ls' })],
  ['a Monitor call', () => call('Monitor', { command: 'tail -f x' })],
  ['a WebFetch', () => call('WebFetch', { url: 'https://example.com' })],
  ['a WebSearch', () => call('WebSearch', { query: 'x' })],
  ['a Read of ~/.ssh/id_ed25519', () => call('Read', { file_path: path('home/.ssh/id_ed25519') })],
  [
    'a Read of the 10db data directory',
    () => call('Read', { file_path: join(dataDir, 'db.sqlite') }),
  ],
  ['a Read outside the checkout', () => call('Read', { file_path: path('outside/notes.txt') })],
  [
    'a Read through a directory link out',
    () => call('Read', { file_path: path('checkout/link-out/notes.txt') }),
  ],
  [
    'a Read through a file link out',
    () => call('Read', { file_path: path('checkout/notes-link') }),
  ],
  [
    'a Read of another conversation’s dropped file',
    () => call('Read', { file_path: path('shapes/shp_other/files/brief.md') }),
  ],
  [
    'a Glob of the directory holding every conversation’s files',
    () => call('Glob', { pattern: '**/*', path: path('shapes') }),
  ],
  ['a Read by ~ that names the home', () => call('Read', { file_path: '~/.ssh/id_ed25519' })],
  [
    'a Read that climbs out with ..',
    () => call('Read', { file_path: path('checkout/../outside/notes.txt') }),
  ],
  [
    'a Grep of a directory holding a protected path',
    () => call('Grep', { pattern: 'x', path: path('checkout') }),
  ],
  ['a Grep with no path (the checkout, which holds one)', () => call('Grep', { pattern: 'x' })],
  [
    'a Grep through a link out',
    () => call('Grep', { pattern: 'x', path: path('checkout/link-out') }),
  ],
  [
    'a Glob that climbs out',
    () => call('Glob', { pattern: '../../outside/*.txt', path: path('checkout/src') }),
  ],
  ['a Glob of the data directory', () => call('Glob', { pattern: '*', path: dataDir })],
  [
    'an Agent that is not a reviewer',
    () => call('Agent', { subagent_type: 'general-purpose', prompt: 'x' }),
  ],
  ['an Agent with no type', () => call('Agent', { prompt: 'x' })],
  ['a lane tool, commit', () => call('mcp__10db__commit', { paths: ['a'] })],
  ['a lane tool, request_claim', () => call('mcp__10db__request_claim', { name: 'api' })],
  ['another server’s tool', () => call('mcp__elsewhere__tool', {})],
  ['a tool nobody has heard of', () => call('Frobnicate', {})],
  ['report_finding from the main session', () => call('mcp__10db__report_finding', {})],
  [
    'report_finding from a subagent that is not a reviewer',
    () =>
      call('mcp__10db__report_finding', {}, { agentId: 'agent-1', agentType: 'general-purpose' }),
  ],
  [
    'report_finding from a subagent of no type',
    () => call('mcp__10db__report_finding', {}, { agentId: 'agent-1' }),
  ],
  [
    'propose_plan from a reviewer',
    () => call('mcp__10db__propose_plan', {}, { agentId: 'agent-1', agentType: 'scope' }),
  ],
  [
    'note_heard from a reviewer',
    () => call('mcp__10db__note_heard', {}, { agentId: 'agent-1', agentType: 'rehearsal' }),
  ],
  [
    'a Bash call from a reviewer',
    () => call('Bash', { command: 'ls' }, { agentId: 'agent-1', agentType: 'scope' }),
  ],
  [
    'a reviewer’s Read outside the checkout',
    () =>
      call('Read', { file_path: path('outside/notes.txt') }, { agentId: 'a', agentType: 'scope' }),
  ],
];

const ALLOWED: readonly (readonly [string, () => ShapeCall])[] = [
  ['a Read of a checkout file', () => call('Read', { file_path: path('checkout/src/a.ts') })],
  ['a Read by a relative path', () => call('Read', { file_path: 'src/a.ts' })],
  [
    'a Grep of a checkout directory with nothing protected',
    () => call('Grep', { pattern: 'a', path: path('checkout/src') }),
  ],
  [
    'a Glob inside the checkout',
    () => call('Glob', { pattern: '**/*.ts', path: path('checkout/src') }),
  ],
  [
    'a Read of this conversation’s dropped file',
    () => call('Read', { file_path: path('shapes/shp_own/files/brief.md') }),
  ],
  ['an Agent for a reviewer', () => call('Agent', { subagent_type: 'rehearsal', prompt: 'x' })],
  ['note_heard', () => call('mcp__10db__note_heard', { items: [] })],
  ['propose_plan', () => call('mcp__10db__propose_plan', {})],
  ['similar_tasks', () => call('mcp__10db__similar_tasks', { query: 'x' })],
  ['find_records', () => call('mcp__10db__find_records', { query: 'x' })],
  [
    'a reviewer’s Read inside the checkout',
    () =>
      call('Read', { file_path: path('checkout/src/a.ts') }, { agentId: 'a', agentType: 'scope' }),
  ],
];

describe('judgeShapeCall', () => {
  it.each(REFUSED)('refuses %s', (_name, make) => {
    const verdict = judgeShapeCall(make(), access);
    expect(verdict.decision).toBe('deny');
  });

  it.each(ALLOWED)('allows %s', (_name, make) => {
    expect(judgeShapeCall(make(), access)).toEqual({ decision: 'allow' });
  });

  it.each(['scope', 'engineering', 'rehearsal'])(
    'lets a %s reviewer report a finding, with the reviewer set from its type over what it wrote',
    (reviewer) => {
      const verdict = judgeShapeCall(
        call(
          'mcp__10db__report_finding',
          { effortKey: 'density', reviewer: 'scope', finding: { kind: 'none' } },
          { agentId: 'agent-1', agentType: reviewer },
        ),
        access,
      );
      expect(verdict).toEqual({
        decision: 'allow',
        updatedInput: { effortKey: 'density', reviewer, finding: { kind: 'none' } },
      });
    },
  );

  it('never answers ask, so nothing reaches the broker or raises a card', () => {
    for (const [, make] of [...REFUSED, ...ALLOWED])
      expect(judgeShapeCall(make(), access).decision).not.toBe('ask');
  });

  it('says why in words the conversation can show', () => {
    const verdict = judgeShapeCall(call('Edit', { file_path: path('checkout/src/a.ts') }), access);
    expect(verdict).toMatchObject({ decision: 'deny' });
    expect('reason' in verdict && verdict.reason).toMatch(/read-only/i);
  });
});
