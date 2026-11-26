import { describe, expect, it } from 'vitest';
import { LinearPostId, Provider, type ExternalLink } from '@10db/contracts';
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
    readOnly: false,
    linearPrefixes: [L],
    link,
    direct: false,
    comments: new Map(),
    uploads: new Map(),
    noteSteers: false,
    pickedStatuses: new Set(),
    ...over,
  };
}

const POST = LinearPostId.parse('lnp_0193a5b0-0000-7000-8000-000000000001');
/** A run whose update has this comment text built by 10db: the only text its `save_comment` may carry. */
const staged = (text: string, written = false): ReporterRun =>
  run({ comments: new Map([[POST, { text, written }]]) });
const reason = (r: ReporterRun, c: { toolName: string; input: unknown }): string => {
  const { verdict } = judgeReporterCall(r, c);
  return verdict.decision === 'deny' ? verdict.reason : '';
};

const call = (toolName: string, input: unknown = {}) => ({ toolName, input });

const upload = (pictureId: string) =>
  call('mcp__10db__upload_linear_picture', { pictureId, uploadUrl: 'x', headers: {} });
const PNG = { filename: '1-home-after.png', contentType: 'image/png', size: 68 };
const prepare = call(`${L}prepare_file_upload`, PNG);
/** A run whose update has this one file named by 10db: the only upload its agent may ask Linear to sign. */
const named = (asked = false, over: Partial<ReporterRun> = {}): ReporterRun =>
  run({
    uploads: new Map([[POST, { ...PNG, asked }]]),
    ...over,
  });
const decision = (r: ReporterRun, c: { toolName: string; input: unknown }) =>
  judgeReporterCall(r, c).verdict.decision;

describe('judgeReporterCall', () => {
  const rows: [string, ReporterRun, { toolName: string; input: unknown }, 'allow' | 'deny'][] = [
    [
      'the comment 10db built, by issueId',
      staged('hi'),
      call(`${L}save_comment`, { issueId: 'iss-119', body: 'hi' }),
      'allow',
    ],
    [
      'a comment 10db did not build',
      staged('hi'),
      call(`${L}save_comment`, { issueId: 'iss-119', body: 'placeholder' }),
      'deny',
    ],
    [
      'a comment with no body built at all',
      run(),
      call(`${L}save_comment`, { issueId: 'iss-119', body: 'hi' }),
      'deny',
    ],
    [
      'the built comment written twice',
      staged('hi', true),
      call(`${L}save_comment`, { issueId: 'iss-119', body: 'hi' }),
      'deny',
    ],
    [
      'comment by identifier',
      staged('hi'),
      call(`${L}save_comment`, { issueId: 'AMP-119', body: 'hi' }),
      'deny',
    ],
    [
      'comment on another issue',
      staged('hi'),
      call(`${L}save_comment`, { issueId: 'iss-7', body: 'hi' }),
      'deny',
    ],
    [
      'comment with an extra key',
      staged('hi'),
      call(`${L}save_comment`, { issueId: 'iss-119', body: 'hi', parentId: 'x' }),
      'deny',
    ],
    [
      'comment under the key issue',
      staged('hi'),
      call(`${L}save_comment`, { issue: 'iss-119', body: 'hi' }),
      'deny',
    ],
    [
      'a comment when 10db writes them itself',
      { ...staged('hi'), direct: true },
      call(`${L}save_comment`, { issueId: 'iss-119', body: 'hi' }),
      'deny',
    ],
    // The agent's Linear writes are its comment and the status 10db picked; links and pictures are 10db's.
    [
      'save_issue state 10db picked',
      run({ pickedStatuses: new Set(['In Review']) }),
      call(`${L}save_issue`, { id: 'iss-119', state: 'In Review' }),
      'allow',
    ],
    [
      'save_issue state 10db did not pick',
      run({ pickedStatuses: new Set(['In Progress']) }),
      call(`${L}save_issue`, { id: 'iss-119', state: 'In Review' }),
      'deny',
    ],
    [
      'save_issue state before any pick',
      run(),
      call(`${L}save_issue`, { id: 'iss-119', state: 'In Progress' }),
      'deny',
    ],
    [
      'save_issue state a steering note names',
      run({ noteSteers: true }),
      call(`${L}save_issue`, { id: 'iss-119', state: 'Ready for Release' }),
      'allow',
    ],
    [
      'save_issue 10db link',
      run(),
      call(`${L}save_issue`, { id: 'iss-119', links: [{ title: '10db', url: PR }] }),
      'deny',
    ],
    ['delete_comment', run(), call(`${L}delete_comment`, { id: 'c-1' }), 'deny'],
    ['gmail connector', run(), call('mcp__claude_ai_Gmail__send_message', {}), 'deny'],
    ['Read', run(), call('Read', { file_path: '/etc/hosts' }), 'deny'],
    ['ToolSearch', run(), call('ToolSearch', { query: 'linear' }), 'allow'],
    ['extract_images', run(), call(`${L}extract_images`, { markdown: '' }), 'deny'],
    [
      'url and code fence',
      staged('see https://a.test\n```\nx\n```'),
      call(`${L}save_comment`, { issueId: 'iss-119', body: 'see https://a.test\n```\nx\n```' }),
      'allow',
    ],
    ['edit by id', staged('edit'), call(`${L}save_comment`, { id: 'c-1', body: 'edit' }), 'deny'],
    [
      'a read carrying a key',
      run(),
      call(`${L}get_issue`, { id: 'sk-ant-abcdefghijklmnopqrstuvwx' }),
      'deny',
    ],
    ['a read', run(), call(`${L}get_issue`, { id: 'iss-119' }), 'allow'],
    ['report tool', run(), call('mcp__10db__report_linear_post', {}), 'allow'],
    ['another 10db tool', run(), call('mcp__10db__commit', {}), 'deny'],
    ['upload a picture', run(), upload('tsc_0193a5b0-0000-7000-8000-000000000001'), 'deny'],
    ['prepare a PNG upload', run(), prepare, 'deny'],
    // Only the one upload 10db named may be asked of Linear, once: its answer is where 10db sends the picture.
    ['the upload 10db named', named(), prepare, 'allow'],
    ['the named upload a second time', named(true), prepare, 'deny'],
    [
      'the named file at another size',
      named(),
      call(`${L}prepare_file_upload`, { ...PNG, size: 69 }),
      'deny',
    ],
    [
      'another file beside the named one',
      named(),
      call(`${L}prepare_file_upload`, { ...PNG, filename: 'notes.txt' }),
      'deny',
    ],
    [
      'the named file as another type',
      named(),
      call(`${L}prepare_file_upload`, { ...PNG, contentType: 'text/html' }),
      'deny',
    ],
    [
      'the named upload with a key Linear does not need',
      named(),
      call(`${L}prepare_file_upload`, { ...PNG, makePublic: true }),
      'deny',
    ],
    ['the named upload in a snapshot', named(false, { readOnly: true }), prepare, 'deny'],
    ['attach a file to Resources', named(), call(`${L}prepare_attachment_upload`, PNG), 'deny'],
    ['attach a file as base64', named(), call(`${L}create_attachment`, PNG), 'deny'],
    [
      'link an upload to the issue',
      named(),
      call(`${L}create_attachment_from_upload`, { issue: 'iss-119', assetUrl: 'https://x' }),
      'deny',
    ],
    [
      'snapshot uploads nothing',
      run({ readOnly: true }),
      upload('tsc_0193a5b0-0000-7000-8000-000000000001'),
      'deny',
    ],
    [
      'snapshot reads the issue',
      run({ readOnly: true }),
      call(`${L}get_issue`, { id: 'x' }),
      'allow',
    ],
    [
      'snapshot reads comments',
      run({ readOnly: true }),
      call(`${L}list_comments`, { issueId: 'x' }),
      'allow',
    ],
    [
      'snapshot writes nothing',
      run({ readOnly: true }),
      call(`${L}save_comment`, { issueId: 'iss-119', body: 'hi' }),
      'deny',
    ],
    ['snapshot lists teams', run({ readOnly: true }), call(`${L}list_teams`, {}), 'deny'],
    [
      'snapshot has no 10db tool',
      run({ readOnly: true }),
      call('mcp__10db__report_linear_post', {}),
      'deny',
    ],
  ];
  it.each(rows)('%s', (_name, r, c, expected) => {
    expect(decision(r, c)).toBe(expected);
  });

  it('withholds a body with a key, naming the pattern', () => {
    const body = 'key sk-ant-abcdefghijklmnopqrstuvwx';
    const out = judgeReporterCall(
      staged(body),
      call(`${L}save_comment`, { issueId: 'iss-119', body }),
    );
    expect(out.verdict.decision).toBe('deny');
    // Only the post the write carries is withheld, never the run's other open rows.
    expect(out.withheld).toEqual({ postId: POST, pattern: 'anthropic_key' });
  });

  it('names the post whose comment an allowed write carries', () => {
    expect(
      judgeReporterCall(staged('hi'), call(`${L}save_comment`, { issueId: 'iss-119', body: 'hi' }))
        .wrote,
    ).toBe(POST);
  });

  it('says which part of a refused write was wrong', () => {
    const r = staged('hi');
    const write = (input: unknown) => reason(r, call(`${L}save_comment`, input));
    expect(write({ issueId: 'AMP-119', body: 'hi' })).toContain(
      'Linear id iss-119, not its key AMP-119',
    );
    expect(write({ issueId: 'iss-119', body: 'hi', parentId: 'x' })).toContain('parentId');
    expect(write({ issue: 'iss-119', body: 'hi' })).toContain('issue');
    expect(write({ issueId: 'iss-119', body: 'placeholder' })).toContain('report_linear_post');
    expect(
      reason(staged('hi', true), call(`${L}save_comment`, { issueId: 'iss-119', body: 'hi' })),
    ).toContain('already written');
  });
});

describe('linearToolPrefixes', () => {
  it('names the connector and each entry', () => {
    expect(
      linearToolPrefixes({ connector: true, entries: ['my linear'], harness: Provider.Claude }),
    ).toEqual([L, 'mcp__my_linear__']);
  });
});
