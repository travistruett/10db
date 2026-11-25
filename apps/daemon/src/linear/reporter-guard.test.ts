import { describe, expect, it } from 'vitest';
import { Provider, TaskScreenId, type ExternalLink } from '@10db/contracts';
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
    ...over,
  };
}

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
