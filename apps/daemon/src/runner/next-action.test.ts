import { mintId, type EvidenceId, type HandoffDto, type NextAction } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { nextActionAfterCrash, nextActionOnAnotherAccount } from './index';

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
    [
      'keeps a revise with the step that rejected',
      { kind: 'revise', reviewStep: 1 },
      'p1',
      { kind: 'revise', reviewStep: 1 },
    ],
    [
      'keeps an uncommitted step with the files it left, so the next session still commits them',
      { kind: 'uncommitted', paths: ['src/api/a.ts'] },
      'p1',
      { kind: 'uncommitted', paths: ['src/api/a.ts'] },
    ],
  ])('%s', (_name, previous, providerSessionId, expected) => {
    expect(nextActionAfterCrash(previous, providerSessionId, handoff)).toEqual(expected);
  });
});

describe('nextActionOnAnotherAccount', () => {
  it.each<[string, NextAction, HandoffDto | null, EvidenceId | null, NextAction]>([
    [
      'starts a resume afresh from the latest handoff',
      { kind: 'resume', providerSessionId: 'p1', reason: 'the usage limit reset' },
      handoff,
      null,
      { kind: 'continue_from_handoff', handoffId: handoff.id },
    ],
    [
      'starts a resume over when the step has no handoff',
      { kind: 'resume', providerSessionId: 'p1', reason: 'the usage limit reset' },
      null,
      null,
      { kind: 'start' },
    ],
    [
      'keeps the gate failure a resumed session was fixing',
      { kind: 'resume', providerSessionId: 'p1', reason: 'the usage limit reset' },
      handoff,
      evidenceId,
      { kind: 'fix', evidenceId },
    ],
    [
      "takes the builder's answer to a fresh session",
      { kind: 'answer', inboxId, providerSessionId: 'p1' },
      handoff,
      null,
      { kind: 'answer', inboxId, providerSessionId: null },
    ],
    [
      'leaves a continuation alone',
      { kind: 'continue_from_handoff', handoffId: handoff.id },
      handoff,
      null,
      { kind: 'continue_from_handoff', handoffId: handoff.id },
    ],
    [
      "takes the builder's answer to a fresh session whatever gate failure it was fixing",
      { kind: 'answer', inboxId, providerSessionId: 'p1' },
      handoff,
      evidenceId,
      { kind: 'answer', inboxId, providerSessionId: null },
    ],
    ['leaves a start alone', { kind: 'start' }, handoff, null, { kind: 'start' }],
    [
      'leaves uncommitted changes alone',
      { kind: 'uncommitted', paths: ['a.txt'] },
      handoff,
      null,
      { kind: 'uncommitted', paths: ['a.txt'] },
    ],
    ['leaves verification alone', { kind: 'verify' }, handoff, null, { kind: 'verify' }],
    [
      'leaves a revision alone',
      { kind: 'revise', reviewStep: 1 },
      handoff,
      null,
      { kind: 'revise', reviewStep: 1 },
    ],
    [
      'leaves a fix alone',
      { kind: 'fix', evidenceId },
      handoff,
      evidenceId,
      { kind: 'fix', evidenceId },
    ],
  ])('%s', (_name, previous, latest, failedGate, expected) => {
    expect(nextActionOnAnotherAccount(previous, latest, failedGate)).toEqual(expected);
  });
});
