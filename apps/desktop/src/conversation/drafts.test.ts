import { describe, expect, it } from 'vitest';
import { EMPTY_DRAFT, afterFailedSend, withoutSent } from './drafts';

describe('what a composer holds once its send succeeds', () => {
  it.each([
    { name: 'only the sent text', typed: ' sent ', want: '' },
    { name: 'a restored text ahead of the sent text', typed: 'failed\n\nsent', want: 'failed' },
    {
      name: 'an edit that no longer holds the sent text',
      typed: 'sent, then more',
      want: 'sent, then more',
    },
  ])('leaves $name once a send succeeds', ({ typed, want }) => {
    expect(withoutSent(typed, 'sent')).toBe(want);
  });
});

describe('what a composer holds once its send fails', () => {
  const sent = { ...EMPTY_DRAFT, text: 'sent' };
  it.each([
    { name: 'the sent text, in an input left empty', typed: '', want: 'sent' },
    { name: 'the sent text once, when it was typed again', typed: ' sent ', want: 'sent' },
    { name: 'the sent text ahead of what was typed since', typed: 'more', want: 'sent\n\nmore' },
  ])('holds $name', ({ typed, want }) => {
    expect(afterFailedSend({ ...EMPTY_DRAFT, text: typed }, sent).text).toBe(want);
  });

  it('puts the sent pictures back ahead of those added since, each once', () => {
    const a = new File(['a'], 'a.png');
    const b = new File(['b'], 'b.png');
    const failed = afterFailedSend(
      { ...EMPTY_DRAFT, pictures: [b] },
      { ...EMPTY_DRAFT, pictures: [a, b] },
    );
    expect(failed.pictures).toEqual([a, b]);
  });

  it('names the mentions of the text it holds', () => {
    const failed = afterFailedSend(
      // The input keeps a picked file as markup beside the text.
      { ...EMPTY_DRAFT, text: 'and ⦃src/b.ts⦄' },
      { text: 'see ⦃src/a.ts⦄', mentions: ['src/a.ts'], pictures: [] },
    );
    expect(failed.mentions).toEqual(['src/a.ts', 'src/b.ts']);
  });
});
