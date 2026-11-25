import { describe, expect, it } from 'vitest';
import { LinearPostId, Provider, TaskScreenId, type ExternalLink } from '@10db/contracts';
import { judgeReporterCall, linearToolPrefixes, type ReporterRun } from './reporter-guard';
import { isLinearUploadUrl, type ReporterPicture } from './reporter-pictures';

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
    prUrl: PR,
    pictures: [],
    withheld: new Set(),
    comments: new Map(),
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

const picture: ReporterPicture = {
  id: TaskScreenId.parse('tsc_0193a5b0-0000-7000-8000-000000000001'),
  name: '1-home-after.png',
  label: 'After, /',
  size: 68,
};
const offered = (): ReporterRun => run({ pictures: [picture] });
const upload = (pictureId: string) =>
  call('mcp__10db__upload_linear_picture', { pictureId, uploadUrl: 'x', headers: {} });
const prepare = call(`${L}prepare_file_upload`, {
  filename: '1-home-after.png',
  contentType: 'image/png',
  size: 68,
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
    ['upload an offered picture', offered(), upload(picture.id), 'allow'],
    [
      'upload a picture not offered',
      offered(),
      upload('tsc_0193a5b0-0000-7000-8000-000000000002'),
      'deny',
    ],
    ['upload with none offered', run(), upload(picture.id), 'deny'],
    ['prepare a PNG upload when offered', offered(), prepare, 'allow'],
    ['prepare an upload with none offered', run(), prepare, 'deny'],
    ['attach a file to Resources', offered(), call(`${L}prepare_attachment_upload`, {}), 'deny'],
    [
      'snapshot uploads nothing',
      run({ readOnly: true, pictures: [picture] }),
      upload(picture.id),
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

  it('sends a picture only to an upload URL Linear signed', () => {
    const signed = (
      over: { host?: string; bucket?: string; signer?: string; scheme?: string } = {},
    ) =>
      `${over.scheme ?? 'https'}://${over.host ?? 'storage.googleapis.com'}/${over.bucket ?? 'linear-uploads-c4-us-east4'}/a/b/c?X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Credential=${encodeURIComponent(`${over.signer ?? 'linear-server@linear-1.iam.gserviceaccount.com'}/20261125/auto/storage/goog4_request`)}&X-Goog-Signature=ab`;
    expect(isLinearUploadUrl(signed())).toBe(true);
    expect(isLinearUploadUrl(signed({ scheme: 'http' }))).toBe(false);
    expect(isLinearUploadUrl(signed({ host: 'evil.test' }))).toBe(false);
    expect(isLinearUploadUrl(signed({ host: 'storage.googleapis.com.evil.test' }))).toBe(false);
    expect(isLinearUploadUrl(signed({ bucket: 'someone-else' }))).toBe(false);
    expect(isLinearUploadUrl(signed({ signer: 'me@evil-project.iam.gserviceaccount.com' }))).toBe(
      false,
    );
    expect(isLinearUploadUrl('https://user:pw@storage.googleapis.com/linear-uploads-x/a')).toBe(
      false,
    );
    expect(isLinearUploadUrl('not a url')).toBe(false);
    const twice = `${signed()}&X-Goog-Credential=${encodeURIComponent('me@evil-project.iam.gserviceaccount.com/x')}`;
    expect(isLinearUploadUrl(twice)).toBe(false);
  });

  it('withholds a body with a key, naming the pattern', () => {
    const body = 'key sk-ant-abcdefghijklmnopqrstuvwx';
    const out = judgeReporterCall(
      staged(body),
      call(`${L}save_comment`, { issueId: 'iss-119', body }),
    );
    expect(out.verdict.decision).toBe('deny');
    expect(out.withheld).toBe('anthropic_key');
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
