import { describe, expect, it } from 'vitest';
import { textPdf } from '../../test/pdf';
import { extractText } from './extraction';

describe('extractText', () => {
  it('reads a PDF in a worker, and a deadline terminates the worker', async () => {
    const text = await extractText({ kind: 'pdf', bytes: textPdf(2) });
    expect(text).toContain('The quick brown fox');
    await expect(extractText({ kind: 'pdf', bytes: textPdf(200) }, 1)).rejects.toThrow(
      'took more than',
    );
  });
});
