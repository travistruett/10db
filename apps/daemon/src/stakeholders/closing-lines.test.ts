import { describe, expect, it } from 'vitest';
import { closingLine } from './closing-lines';

describe('closingLine', () => {
  it.each([
    ['the builder answered an option', 'builder', 'B', 'Travis answered this one: B. Thanks!'],
    ['the builder answered in words', 'builder', null, 'Travis answered this one. Thanks!'],
    ['the builder took it back', 'taken_back', null, 'Never mind this one, Travis has it. Thanks!'],
    ['the card was cancelled', 'cancelled', null, 'This one is no longer needed. Thanks!'],
  ] as const)('%s', (_name, reason, choice, line) => {
    expect(closingLine(reason, 'Travis', choice)).toBe(line);
  });

  it('escapes the builder name so it cannot ping', () => {
    expect(closingLine('taken_back', '<!channel>', null)).not.toContain('<!channel>');
  });
});
