import { fitNotice, NOTICE_BODY_MAX } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { rerunNotices, rerunRecord, type RerunRuns } from './notices';

const HEAD = 'a'.repeat(40);

describe('the rerun notice', () => {
  const runs: RerunRuns = new Map([['77', [{ name: 'desktop' }]]]);

  it('shows prose only: no JSON and no run id record in the line or the body', () => {
    for (const state of ['asking', 'refused', 'done'] as const) {
      const notice = rerunNotices.ran(HEAD, runs, state);
      expect(notice.body).not.toContain('{');
      expect(notice.body).not.toContain('Runs 10db started');
      expect(notice.body).not.toContain('"77"');
      expect(notice.line).not.toContain('{');
    }
  });

  it('keeps the stored runs and whether 10db is done asking apart from the prose', () => {
    const asking = rerunRecord(rerunNotices.ran(HEAD, runs, 'asking'));
    expect(asking).toEqual({ runs: new Map([['77', [{ name: 'desktop' }]]]), done: false });
    const refused = rerunRecord(rerunNotices.ran(HEAD, runs, 'refused'));
    expect(refused).toEqual({ runs: new Map([['77', [{ name: 'desktop' }]]]), done: false });
    const done = rerunRecord(rerunNotices.ran(HEAD, runs, 'done'));
    expect(done).toEqual({ runs: new Map([['77', [{ name: 'desktop' }]]]), done: true });
  });

  it('says 10db runs the rest as soon as GitHub allows only while it is still asking', () => {
    expect(rerunNotices.ran(HEAD, runs, 'asking').body).toContain('as soon as GitHub allows');
    expect(rerunNotices.ran(HEAD, runs, 'done').body).not.toContain('as soon as GitHub allows');
  });

  it('does not say 10db will run a check GitHub refused', () => {
    const body = rerunNotices.ran(HEAD, runs, 'refused').body;
    expect(body).not.toContain('as soon as GitHub allows');
    expect(body).toContain('refused');
    expect(body).toContain('will not ask again');
  });

  it('keeps the record when the stored notice is cut to fit', () => {
    const many: RerunRuns = new Map(
      Array.from({ length: 400 }, (_, i) => [String(1000 + i), [{ name: `check-${String(i)}` }]]),
    );
    const notice = rerunNotices.ran(HEAD, many, 'asking');
    const fitted = fitNotice({ ...notice, body: `${notice.body}${'x'.repeat(NOTICE_BODY_MAX)}` });
    expect(fitted.body.length).toBeLessThanOrEqual(NOTICE_BODY_MAX);
    const record = rerunRecord(fitted);
    expect(record?.runs.size).toBe(400);
    expect(record?.done).toBe(false);
  });

  it('reads a notice an older daemon stored, with the record in its body', () => {
    const older = {
      key: `checks-rerun:${HEAD}`,
      tone: 'info' as const,
      line: 'Required check "desktop" was cancelled; 10db ran it again',
      body: 'Prose.\n\nRuns 10db started (run id: its checks, then whether it is done): {"runs":{"77":["desktop"]},"done":false}',
    };
    expect(rerunRecord(older)).toEqual({
      runs: new Map([['77', [{ name: 'desktop' }]]]),
      done: false,
    });
  });

  it('reads no record from a notice that has none', () => {
    expect(
      rerunRecord({ key: `checks-rerun:${HEAD}`, tone: 'info', line: 'x', body: 'Only prose.' }),
    ).toBeNull();
  });
});
