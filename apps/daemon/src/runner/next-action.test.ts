import {
  mintId,
  type EvidenceId,
  type HandoffDto,
  type NextAction,
  type TaskMessageId,
} from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { nextActionAfterCrash, nextActionOnAnotherAccount } from './index';
import { withUndelivered } from './next-action';

const handoff = { id: mintId('Handoff') } as HandoffDto;
const inboxId = mintId('InboxItem');
const evidenceId = mintId('Evidence');
const messageId = mintId('TaskMessage');
const laterId = mintId('TaskMessage');

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
      "keeps the builder's message, resuming the fresh session that crashed before taking it",
      { kind: 'feedback', messageId, providerSessionId: null },
      'p2',
      { kind: 'feedback', messageId, providerSessionId: 'p2' },
    ],
    [
      "keeps the builder's message for a fresh session when the crashed one reported no provider session",
      { kind: 'feedback', messageId, providerSessionId: null },
      null,
      { kind: 'feedback', messageId, providerSessionId: null },
    ],
    [
      "starts the builder's message afresh from the digest when its resumed session crashed",
      { kind: 'feedback', messageId, providerSessionId: 'p1' },
      'p1',
      { kind: 'feedback', messageId, providerSessionId: null },
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
    [
      'keeps a merge with its files, so the next session still resolves them',
      { kind: 'merge', base: 'origin/main', paths: ['src/api/a.ts'] },
      'p1',
      { kind: 'merge', base: 'origin/main', paths: ['src/api/a.ts'] },
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
    [
      "takes the builder's message to a fresh session, whose first message is the digest and it",
      { kind: 'feedback', messageId, providerSessionId: 'p1' },
      handoff,
      evidenceId,
      { kind: 'feedback', messageId, providerSessionId: null },
    ],
    ['leaves a start alone', { kind: 'start' }, handoff, null, { kind: 'start' }],
    [
      'leaves uncommitted changes alone',
      { kind: 'uncommitted', paths: ['a.txt'] },
      handoff,
      null,
      { kind: 'uncommitted', paths: ['a.txt'] },
    ],
    [
      'leaves a merge alone',
      { kind: 'merge', base: 'origin/main', paths: ['a.txt'] },
      handoff,
      null,
      { kind: 'merge', base: 'origin/main', paths: ['a.txt'] },
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

describe('withUndelivered', () => {
  it.each<[string, NextAction, TaskMessageId | null, NextAction]>([
    [
      'leaves the action alone when every message was taken',
      { kind: 'start' },
      null,
      { kind: 'start' },
    ],
    [
      'resumes the session with the message it never took',
      { kind: 'resume', providerSessionId: 'p1', reason: 'the session crashed' },
      messageId,
      { kind: 'feedback', messageId, providerSessionId: 'p1' },
    ],
    [
      'starts fresh with the message when the session cannot be resumed',
      { kind: 'start' },
      messageId,
      { kind: 'feedback', messageId, providerSessionId: null },
    ],
    [
      'starts fresh from the handoff with the message the handed-off session never took',
      { kind: 'continue_from_handoff', handoffId: handoff.id },
      messageId,
      { kind: 'feedback', messageId, providerSessionId: null },
    ],
    [
      'names the oldest message not taken, keeping the session a feedback would resume',
      { kind: 'feedback', messageId: laterId, providerSessionId: 'p1' },
      messageId,
      { kind: 'feedback', messageId, providerSessionId: 'p1' },
    ],
    [
      'keeps an answer, whose session is handed the message after it',
      { kind: 'answer', inboxId, providerSessionId: 'p1' },
      messageId,
      { kind: 'answer', inboxId, providerSessionId: 'p1' },
    ],
    ['keeps verification', { kind: 'verify' }, messageId, { kind: 'verify' }],
    ['keeps a fix', { kind: 'fix', evidenceId }, messageId, { kind: 'fix', evidenceId }],
  ])('%s', (_name, next, undelivered, expected) => {
    expect(withUndelivered(next, undelivered)).toEqual(expected);
  });
});
