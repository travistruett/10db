import { describe, expect, it } from 'vitest';
import { createLogger } from './index';

describe('createLogger', () => {
  it('redacts tokens and authorization headers', () => {
    const lines: string[] = [];
    const logger = createLogger({
      level: 'info',
      destination: {
        write: (line: string) => {
          lines.push(line);
        },
      },
    });
    logger.info(
      {
        token: 'secret-1',
        mcp: { token: 'secret-2' },
        headers: { authorization: 'Bearer secret-3' },
      },
      'starting',
    );
    const text = lines.join('');
    expect(text).toContain('starting');
    expect(text).not.toMatch(/secret-[1-5]/);
    expect(text).toContain('[redacted]');
  });
});
