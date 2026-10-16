import { describe, expect, it } from 'vitest';
import { createLogger } from './index';

const keys = ['token', 'authorization', 'mcpToken'] as const;
const depths = [0, 1, 2] as const;

// Wraps `{ [key]: secret }` in `depth` levels of nesting.
function nest(key: string, depth: number): object {
  let value: object = { [key]: 'the-secret' };
  for (let level = 0; level < depth; level += 1) {
    value = { wrap: value };
  }
  return value;
}

const rows = keys.flatMap((key) =>
  depths.map((depth) => ({ name: `${key} at depth ${String(depth)}`, key, depth })),
);

describe('createLogger', () => {
  it.each(rows)('redacts $name', ({ key, depth }) => {
    const lines: string[] = [];
    const logger = createLogger({
      level: 'info',
      destination: {
        write: (line: string) => {
          lines.push(line);
        },
      },
    });
    logger.info(nest(key, depth), 'starting');
    const text = lines.join('');
    expect(text).toContain('starting');
    expect(text).not.toContain('the-secret');
    expect(text).toContain('[redacted]');
  });
});
