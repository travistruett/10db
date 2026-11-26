import { describe, expect, it } from 'vitest';
import { loginOutputTail } from './sign-in-output';

// Value: protects=a dev login's sign-in address and secrets never reach Settings or a card;
// fails_when=the tail shows a token, a query string or a credential assignment as printed;
// why_new=secrets kept out of the output a builder reads (core: secrets);
// no_claim=every secret format is caught, only the outbound scan's patterns and long bare tokens.

describe('loginOutputTail', () => {
  it('masks sign-in addresses, queries, credentials and bare tokens, and keeps the error text', () => {
    const out = loginOutputTail(
      [
        'creating frontend-e2e user',
        'Error: user insert failed',
        'open http://localhost:5173/auth/dev?token=abc123',
        '/auth/dev?session=zzz',
        'password = hunter2',
        'sk-ant-api03-abcdefghijklmnopqrstuvwxyz',
        'aGVsbG8gd29ybGQgdGhpcyBpcyBhIHNlc3Npb24',
      ].join('\n'),
    );
    expect(out).toContain('Error: user insert failed');
    expect(out).not.toMatch(/abc123|zzz|hunter2|localhost|sk-ant|aGVsbG8/);
  });

  it('keeps only the last lines', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${String(i)}`).join('\n');
    const out = loginOutputTail(lines).split('\n');
    expect(out).toHaveLength(12);
    expect(out.at(-1)).toBe('line 29');
  });
});
