import { describe, expect, it } from 'vitest';
import { textPdf } from '../../test/pdf';
import { extractText } from './extraction';

describe('extractText', () => {
  it('reads a PDF in a worker, and a deadline terminates the worker', async () => {
    const text = await extractText({ kind: 'pdf', bytes: textPdf(2) });
    expect(text).toContain('The quick brown fox');
    // Long enough that reading it on the main thread would starve the timer past the deadline.
    await expect(extractText({ kind: 'pdf', bytes: textPdf(1500) }, 300)).rejects.toThrow(
      'took more than',
    );
  });
});
