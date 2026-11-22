import { describe, expect, it } from 'vitest';
import { Provider, type ExternalLink } from '@10db/contracts';
import { judgeReporterCall, linearToolPrefixes, type ReporterRun } from './reporter-guard';

const L = 'mcp__claude_ai_Linear__';
const PR = 'https://github.com/acme/app/pull/7';

const link: ExternalLink = {
  kind: 'linear',
  id: 'AMP-119',
  issueId: 'iss-119',
  url: 'https://linear.app/acme/issue/AMP-119',
};

function run(over: Partial<ReporterRun> = {}): ReporterRun {
  return {
    linearPrefixes: [L],
    link,
    prUrl: PR,
    uploads: [],
    withheld: new Set(),
    ...over,
  };
}

const call = (toolName: string, input: unknown = {}) => ({ toolName, input });
const decision = (r: ReporterRun, c: { toolName: string; input: unknown }) =>
  judgeReporterCall(r, c).verdict.decision;

describe('judgeReporterCall', () => {
  const rows: [string, ReporterRun, { toolName: string; input: unknown }, 'allow' | 'deny'][] = [
    [
      'comment by issueId',
      run(),
      call(`${L}save_comment`, { issueId: 'iss-119', body: 'hi' }),
      'allow',
    ],
    [
      'comment by identifier',
      run(),
      call(`${L}save_comment`, { issueId: 'AMP-119', body: 'hi' }),
      'deny',
    ],
    [
      'comment on another issue',
      run(),
      call(`${L}save_comment`, { issueId: 'iss-7', body: 'hi' }),
      'deny',
    ],
    [
      'comment with an extra key',
      run(),
      call(`${L}save_comment`, { issueId: 'iss-119', body: 'hi', parentId: 'x' }),
      'deny',
    ],
    [
      'save_issue with parentId',
      run(),
      call(`${L}save_issue`, { id: 'iss-119', parentId: 'x' }),
      'deny',
    ],
    [
      'save_issue state',
      run(),
      call(`${L}save_issue`, { id: 'iss-119', state: 'In Review' }),
      'allow',
    ],
    [
      'save_issue 10db link',
      run(),
      call(`${L}save_issue`, { id: 'iss-119', links: [{ title: '10db', url: PR }] }),
      'allow',
    ],
    [
      'save_issue other link',
      run(),
      call(`${L}save_issue`, {
        id: 'iss-119',
        links: [{ title: '10db', url: 'https://evil.test' }],
      }),
      'deny',
    ],
    ['delete_comment', run(), call(`${L}delete_comment`, { id: 'c-1' }), 'deny'],
    ['gmail connector', run(), call('mcp__claude_ai_Gmail__send_message', {}), 'deny'],
    ['Read', run(), call('Read', { file_path: '/etc/hosts' }), 'deny'],
    ['ToolSearch', run(), call('ToolSearch', { query: 'linear' }), 'allow'],
    ['extract_images', run(), call(`${L}extract_images`, { markdown: '' }), 'deny'],
    [
      'url and code fence',
      run(),
      call(`${L}save_comment`, { issueId: 'iss-119', body: 'see https://a.test\n```\nx\n```' }),
      'allow',
    ],
    ['edit by id', run(), call(`${L}save_comment`, { id: 'c-1', body: 'edit' }), 'deny'],
    [
      'a read carrying a key',
      run(),
      call(`${L}get_issue`, { id: 'sk-ant-abcdefghijklmnopqrstuvwx' }),
      'deny',
    ],
    ['a read', run(), call(`${L}get_issue`, { id: 'iss-119' }), 'allow'],
    ['report tool', run(), call('mcp__10db__report_linear_post', {}), 'allow'],
    ['another 10db tool', run(), call('mcp__10db__commit', {}), 'deny'],
  ];
  it.each(rows)('%s', (_name, r, c, expected) => {
    expect(decision(r, c)).toBe(expected);
  });

  it('withholds a body with a key, naming the pattern', () => {
    const out = judgeReporterCall(
      run(),
      call(`${L}save_comment`, { issueId: 'iss-119', body: 'key sk-ant-abcdefghijklmnopqrstuvwx' }),
    );
    expect(out.verdict.decision).toBe('deny');
    expect(out.withheld).toBe('anthropic_key');
  });
});

describe('linearToolPrefixes', () => {
  it('names the connector and each entry', () => {
    expect(
      linearToolPrefixes({ connector: true, entries: ['my linear'], harness: Provider.Claude }),
    ).toEqual([L, 'mcp__my_linear__']);
  });
});
