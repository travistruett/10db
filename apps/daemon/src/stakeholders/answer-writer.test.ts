import { describe, expect, it } from 'vitest';
import { ANSWER_LIMIT, acceptWritten, type WrittenAnswer } from './answer-writer';

const reply = (answer: string, answerable = true): string => JSON.stringify({ answerable, answer });
const declined = (reason: string): WrittenAnswer => ({ kind: 'declined', reason }) as WrittenAnswer;

describe('acceptWritten', () => {
  it.each([
    [
      'a good answer',
      `Sure: ${reply('It checks the cache first.')} done`,
      { kind: 'answer', text: 'It checks the cache first.' },
    ],
    ['not answerable', reply('I think so', false), declined('not_answerable')],
    ['too long', reply('a'.repeat(ANSWER_LIMIT + 1)), declined('too_long')],
    ['a link', reply('See https://example.com/x'), declined('held')],
    ['a key', reply('Use sk-ant-abcdefghijklmnopqrstuvwxyz'), declined('held')],
    ['a file path', reply('It is in apps/daemon/src/x.ts'), declined('held')],
    ['prose with no JSON', 'It checks the cache first.', declined('unparseable')],
  ] as const)('%s', (_name, raw, expected) => {
    expect(acceptWritten(raw)).toEqual(expected);
  });
});
