import { ReplyKind, type InboxOption } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { ruleReplyKind } from './reply-kind';

const options: InboxOption[] = [
  { label: 'Ship it', description: '' },
  { label: 'Wait a day', description: '' },
  { label: 'Cancel', description: '' },
];

describe('ruleReplyKind', () => {
  it.each([
    ['B', ReplyKind.Answer],
    ['b) but quickly', ReplyKind.Answer],
    ['what is this for?', ReplyKind.BuilderQuestion],
    ['Why not C', ReplyKind.BuilderQuestion],
    ['Should be B', ReplyKind.Answer],
    ['sounds fine, ship it', ReplyKind.Answer],
    ['   ', ReplyKind.Chatter],
  ])('%j is %s', (words, kind) => {
    expect(ruleReplyKind({ words, messageCount: 1 }, options)).toBe(kind);
  });
});
