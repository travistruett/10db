import { fitNotice, NOTICE_BODY_MAX } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import {
  cancelledNoticeHead,
  cancelledNoticeKind,
  cancelledNotices,
  leftOutNotices,
  migrationNotices,
  rerunNotices,
  rerunRecord,
  type RerunRuns,
  uncarriedIn,
  uncarriedSaid,
} from './notices';

const HEAD = 'a'.repeat(40);

describe('the already-reverted left-out notice', () => {
  // It is written for a run that was retried and failed again, and for one that never was: a later
  // Ship without it finds the revert still on the branch either way.
  const { body, line } = leftOutNotices.alreadyReverted('b'.repeat(40));

  it('names the earlier revert and says nothing more was reverted', () => {
    expect(body).toContain('bbbbbbbbb');
    expect(body).toMatch(/reverted nothing more/);
    expect(line).toMatch(/already reverted/);
  });

  it('does not claim the run failed again or was retried', () => {
    expect(body).not.toMatch(/failed again/i);
    expect(body).not.toMatch(/retry added none/i);
    expect(body).not.toMatch(/the retry\b/i);
  });
});

describe('the renumbered migrations notice', () => {
  const lines = (notice: { readonly record?: string | undefined }): unknown =>
    JSON.parse(notice.record ?? '[]');

  it('replaces the line of a migration renumbered again from the same tag', () => {
    const first = migrationNotices.renumbered(undefined, [{ from: '0042_x', to: '0043_x' }]);
    const again = migrationNotices.renumbered(first, [{ from: '0042_x', to: '0044_x' }]);

    expect(lines(again)).toEqual([{ from: '0042_x', to: '0044_x' }]);
    expect(again.line).toContain('1 of this batch');
    expect(again.body).toContain('0042_x → 0044_x');
    expect(again.body).not.toContain('0043_x');
  });

  it('keeps one line when the same renumbering is told twice', () => {
    const first = migrationNotices.renumbered(undefined, [{ from: '0042_x', to: '0043_x' }]);
    const again = migrationNotices.renumbered(first, [{ from: '0042_x', to: '0043_x' }]);

    expect(lines(again)).toEqual([{ from: '0042_x', to: '0043_x' }]);
  });

  it('still follows a migration moved on from the tag it holds now', () => {
    const first = migrationNotices.renumbered(undefined, [{ from: '0042_x', to: '0043_x' }]);
    const again = migrationNotices.renumbered(first, [{ from: '0043_x', to: '0044_x' }]);

    expect(lines(again)).toEqual([{ from: '0042_x', to: '0044_x' }]);
  });
});

describe('reading the lost-migrations notice', () => {
  const stored = migrationNotices.uncarried([{ tag: '0001_x', at: 'abc' }]);

  it('reads the list, and an empty one when there is no notice', () => {
    expect(uncarriedIn(stored)).toEqual([{ tag: '0001_x', at: 'abc' }]);
    expect(uncarriedIn(undefined)).toEqual([]);
  });

  it('answers null, not an empty list, when the notice has no list it can read', () => {
    expect(
      uncarriedIn({ key: stored.key, tone: stored.tone, line: stored.line, body: stored.body }),
    ).toBeNull();
    expect(uncarriedIn({ ...stored, record: 'not json' })).toBeNull();
    expect(uncarriedIn({ ...stored, record: '{"tag":"0001_x"}' })).toBeNull();
  });

  it("says the notice's own text while its list reads, and no steps that can't clear it otherwise", () => {
    expect(uncarriedSaid(stored)).toBe(stored.body);

    const said = uncarriedSaid({ ...stored, record: 'not json' });
    expect(said).toContain('could not be read');
    expect(said).toContain('cut short');
    expect(said).toContain("won't clear this notice");
    expect(said).toContain('abandoning the batch');
    expect(said).not.toContain(stored.body);
  });
});

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

  it('says 10db runs no other check once it stopped, and names no notice once that one cleared', () => {
    const stopped = rerunNotices.ran(HEAD, runs, 'stopped').body;
    expect(stopped).not.toContain('as soon as GitHub allows');
    expect(stopped).toContain('will not run another');
    const cleared = rerunNotices.ran(HEAD, runs, 'cleared').body;
    expect(cleared).not.toContain('beside this one');
    expect(cleared).not.toContain('will not');
    for (const state of ['stopped', 'cleared'] as const) {
      expect(rerunRecord(rerunNotices.ran(HEAD, runs, state))?.done).toBe(false);
    }
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

describe('the cancelled-check notice kind', () => {
  const batch = { baseBranch: 'main', prUrl: null } as unknown as Parameters<
    typeof cancelledNotices.stuck
  >[0];
  const checks = [{ name: 'desktop', link: null }];

  it.each([
    [{ kind: 'again' }, 'again'],
    [{ kind: 'no_run' }, 'stopped'],
    [{ kind: 'refused', detail: 'HTTP 403' }, 'stopped'],
  ] as const)('stores %j as %s, and reads it back without showing it', (why, kind) => {
    const notice = cancelledNotices.stuck(batch, checks, why);
    expect(cancelledNoticeKind(notice)).toBe(kind);
    expect(notice.body).not.toContain('{"kind"');
  });

  it('stores the head it is about, and reads it back without showing it', () => {
    const notice = cancelledNotices.stuck(batch, checks, { kind: 'again' }, HEAD);
    expect(cancelledNoticeHead(notice)).toBe(HEAD);
    expect(notice.body).not.toContain(HEAD);
    expect(cancelledNoticeKind(notice)).toBe('again');
  });

  it('reads no head from a notice that has none', () => {
    const notice = cancelledNotices.stuck(batch, checks, { kind: 'again' });
    expect(cancelledNoticeHead(notice)).toBeNull();
    expect(cancelledNoticeHead({ ...notice, record: undefined })).toBeNull();
    expect(cancelledNoticeHead({ ...notice, record: '{"kind":"again"}' })).toBeNull();
  });

  it('reads no kind from an older notice with no record', () => {
    const notice = cancelledNotices.stuck(batch, checks, { kind: 'again' });
    expect(cancelledNoticeKind({ ...notice, record: undefined })).toBeNull();
  });
});
