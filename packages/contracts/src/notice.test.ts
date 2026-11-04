import { describe, expect, it } from 'vitest';
import { fitNotice, Notice, NOTICE_RECORD_MAX } from './entities';

const base: Notice = { key: 'k', tone: 'info', line: 'A line', body: 'A body' };

describe('fitNotice and the record', () => {
  it('keeps a record at the limit whole', () => {
    const record = 'r'.repeat(NOTICE_RECORD_MAX);
    const fitted = fitNotice({ ...base, record });
    expect(fitted.record).toBe(record);
    expect(Notice.safeParse(fitted).success).toBe(true);
  });

  it('leaves off a record over the limit rather than cutting it, and the notice still parses', () => {
    const fitted = fitNotice({ ...base, record: 'r'.repeat(NOTICE_RECORD_MAX + 1) });
    expect('record' in fitted).toBe(false);
    expect(fitted).toEqual(base);
    expect(Notice.safeParse(fitted).success).toBe(true);
  });
});
