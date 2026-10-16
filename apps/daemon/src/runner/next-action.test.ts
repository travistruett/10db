import { mintId, type HandoffDto, type NextAction } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { nextActionAfterCrash } from './index';

const handoff = { id: mintId('Handoff') } as HandoffDto;
const inboxId = mintId('InboxItem');
const evidenceId = mintId('Evidence');

describe('nextActionAfterCrash', () => {
  it.each<[string, NextAction, string | null, HandoffDto | null, NextAction['kind']]>([
    ['resumes a session that has a provider id', { kind: 'start' }, 'p1', null, 'resume'],
    [
      'starts fresh from the handoff after a failed resume',
      { kind: 'resume', providerSessionId: 'p1', reason: 'x' },
      'p1',
      handoff,
      'continue_from_handoff',
    ],
    [
      'starts over when a resume failed and there is no handoff',
      { kind: 'resume', providerSessionId: 'p1', reason: 'x' },
      'p1',
      null,
      'start',
    ],
    [
      'continues from the handoff when the provider never started',
      { kind: 'start' },
      null,
      handoff,
      'continue_from_handoff',
    ],
    ['keeps verification as verification', { kind: 'verify' }, 'p1', handoff, 'verify'],
  ])('%s', (_name, previous, providerSessionId, latest, kind) => {
    expect(nextActionAfterCrash(previous, providerSessionId, latest).kind).toBe(kind);
  });
});

describe('nextActionAfterCrash with builder input', () => {
  it.each<[string, NextAction, string | null, NextAction]>([
    [
      'keeps an answer, resuming the provider session the crashed one reported',
      { kind: 'answer', inboxId, providerSessionId: 'p1' },
      'p2',
      { kind: 'answer', inboxId, providerSessionId: 'p2' },
    ],
    [
      'keeps an answer whose session crashed before reporting a provider session',
      { kind: 'answer', inboxId, providerSessionId: 'p1' },
      null,
      { kind: 'answer', inboxId, providerSessionId: 'p1' },
    ],
    [
      'keeps a fix with its gate evidence',
      { kind: 'fix', evidenceId },
      'p1',
      { kind: 'fix', evidenceId },
    ],
  ])('%s', (_name, previous, providerSessionId, expected) => {
    expect(nextActionAfterCrash(previous, providerSessionId, handoff)).toEqual(expected);
  });
});
