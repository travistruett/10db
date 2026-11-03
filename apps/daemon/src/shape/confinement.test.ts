import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  judgeShapeCall,
  RESEARCH_QUERY_LIMIT,
  RESEARCH_QUESTION_LIMIT,
  RESEARCH_URL_LIMIT,
  type ShapeAccess,
  type ShapeCall,
} from './confinement';

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
  // Research (§5.2): only the researcher touches the network, and it reads nothing.
  ...(['scope', 'engineering', 'rehearsal', 'general-purpose'] as const).flatMap((agentType) => [
    [
      `a WebSearch from the ${agentType} agent`,
      () => call('WebSearch', { query: 'x' }, { agentId: 'a', agentType }),
    ] as const,
    [
      `a WebFetch from the ${agentType} agent`,
      () => call('WebFetch', { url: 'https://example.com/' }, { agentId: 'a', agentType }),
    ] as const,
  ]),
  [
    'a WebSearch from a subagent of no type',
    () => call('WebSearch', { query: 'x' }, { agentId: 'a' }),
  ],
  ...(
    [
      ['a Read of a checkout file', 'Read', () => ({ file_path: path('checkout/src/a.ts') })],
      ['a Read of a dropped file', 'Read', () => ({ file_path: path('files/brief.md') })],
      [
        'a Grep of a checkout directory',
        'Grep',
        () => ({ pattern: 'a', path: path('checkout/src') }),
      ],
      ['a Grep of the files directory', 'Grep', () => ({ pattern: 'a', path: path('files') })],
      [
        'a Glob of a checkout directory',
        'Glob',
        () => ({ pattern: '**/*.ts', path: path('checkout/src') }),
      ],
      ['a Glob of the files directory', 'Glob', () => ({ pattern: '*', path: path('files') })],
    ] as const
  ).map(
    ([name, tool, input]) =>
      [
        `${name} from the researcher`,
        () => call(tool, input(), { agentId: 'a', agentType: 'researcher' }),
      ] as const,
  ),
  [
    'a Bash call from the researcher',
    () => call('Bash', { command: 'curl x' }, { agentId: 'a', agentType: 'researcher' }),
  ],
  [
    'an Agent launched by the researcher',
    () =>
      call(
        'Agent',
        { subagent_type: 'researcher', prompt: 'x' },
        { agentId: 'a', agentType: 'researcher' },
      ),
  ],
  [
    'report_finding from the researcher',
    () => call('mcp__10db__report_finding', {}, { agentId: 'a', agentType: 'researcher' }),
  ],
  [
    'propose_plan from the researcher',
    () => call('mcp__10db__propose_plan', {}, { agentId: 'a', agentType: 'researcher' }),
  ],
  [
    'see_screen from the researcher',
    () =>
      call('mcp__10db__see_screen', { screen: 'board' }, { agentId: 'a', agentType: 'researcher' }),
  ],
  [
    'see_screen from a reviewer',
    () =>
      call('mcp__10db__see_screen', { screen: 'board' }, { agentId: 'a', agentType: 'rehearsal' }),
  ],
  [
    'a browser tool of any kind',
    () => call('mcp__playwright__browser_navigate', { url: 'http://127.0.0.1:1420' }),
  ],
  ['a click or a key into a screen', () => call('mcp__10db__click', { selector: 'button' })],
  [
    'find_records from the researcher',
    () =>
      call('mcp__10db__find_records', { query: 'x' }, { agentId: 'a', agentType: 'researcher' }),
  ],
  [
    'an Agent for the researcher with a question over the limit',
    () =>
      call('Agent', {
        subagent_type: 'researcher',
        prompt: 'x'.repeat(RESEARCH_QUESTION_LIMIT + 1),
      }),
  ],
  [
    'an Agent for the researcher with no question',
    () => call('Agent', { subagent_type: 'researcher' }),
  ],
  ...(
    [
      ['a page over http', 'http://example.com/'],
      ['a file URL', 'file:///etc/passwd'],
      ['a URL with a login', 'https://user:pw@example.com/'],
      ['a URL that is not one', 'not a url'],
      ['localhost', 'https://localhost/'],
      ['a name under localhost', 'https://app.localhost/'],
      ['a loopback address', 'https://127.0.0.1/'],
      ['a loopback address in decimal', 'https://2130706433/'],
      ['a private address', 'https://192.168.1.1/'],
      ['an IPv6 address', 'https://[::1]/'],
      ['a name with one label', 'https://intranet/'],
      ['a .local host', 'https://printer.local/'],
      ['a .internal host', 'https://metadata.google.internal/'],
      ['a port other than 443', 'https://example.com:8443/'],
      ['a URL over the limit', `https://example.com/${'a'.repeat(RESEARCH_URL_LIMIT)}`],
    ] as const
  ).map(
    ([name, url]) =>
      [
        `the researcher’s WebFetch of ${name}`,
        () => call('WebFetch', { url }, { agentId: 'a', agentType: 'researcher' }),
      ] as const,
  ),
  [
    'the researcher’s WebFetch with no url',
    () => call('WebFetch', {}, { agentId: 'a', agentType: 'researcher' }),
  ],
  [
    'the researcher’s WebSearch with no query',
    () => call('WebSearch', { query: '  ' }, { agentId: 'a', agentType: 'researcher' }),
  ],
  [
    'the researcher’s WebSearch of a query over the limit',
    () =>
      call(
        'WebSearch',
        { query: 'x'.repeat(RESEARCH_QUERY_LIMIT + 1) },
        { agentId: 'a', agentType: 'researcher' },
      ),
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
  ['see_screen', () => call('mcp__10db__see_screen', { screen: 'board' })],
  [
    'a reviewer’s Read inside the checkout',
    () =>
      call('Read', { file_path: path('checkout/src/a.ts') }, { agentId: 'a', agentType: 'scope' }),
  ],
  [
    'an Agent for the researcher',
    () => call('Agent', { subagent_type: 'researcher', prompt: 'How does Vega-Lite handle ties?' }),
  ],
  [
    'the researcher’s WebSearch',
    () =>
      call(
        'WebSearch',
        { query: 'vega-lite stack ties', allowed_domains: ['vega.github.io'] },
        { agentId: 'a', agentType: 'researcher' },
      ),
  ],
  [
    'the researcher’s WebFetch of a public page',
    () =>
      call(
        'WebFetch',
        { url: 'https://vega.github.io/vega-lite/docs/stack.html', prompt: 'ties' },
        { agentId: 'a', agentType: 'researcher' },
      ),
  ],
  [
    'the researcher’s WebFetch with the port 443 named',
    () =>
      call(
        'WebFetch',
        { url: 'https://example.com:443/a?b=c#d' },
        { agentId: 'a', agentType: 'researcher' },
      ),
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

  it('says why the main session may not search or fetch, in words the conversation can show', () => {
    const verdict = judgeShapeCall(call('WebSearch', { query: 'x' }), access);
    expect(verdict).toMatchObject({ decision: 'deny' });
    expect('reason' in verdict && verdict.reason).toMatch(/researcher/i);
  });

  it('says why the researcher may not read, naming that it holds no project files', () => {
    const verdict = judgeShapeCall(
      call(
        'Read',
        { file_path: path('checkout/src/a.ts') },
        { agentId: 'a', agentType: 'researcher' },
      ),
      access,
    );
    expect(verdict).toMatchObject({ decision: 'deny' });
    expect('reason' in verdict && verdict.reason).toMatch(/researcher/i);
  });

  it('says why in words the conversation can show', () => {
    const verdict = judgeShapeCall(call('Edit', { file_path: path('checkout/src/a.ts') }), access);
    expect(verdict).toMatchObject({ decision: 'deny' });
    expect('reason' in verdict && verdict.reason).toMatch(/read-only/i);
  });
});
