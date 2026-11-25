import {
  mintId,
  type EvidenceId,
  type HandoffDto,
  type NextAction,
  type TaskMessageId,
} from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { nextActionAfterCrash, nextActionOnAnotherAccount } from './index';
import { keepingFeedback, resumedSessionOf, withUndelivered } from './next-action';

const handoff = { id: mintId('Handoff') } as HandoffDto;
const inboxId = mintId('InboxItem');
const evidenceId = mintId('Evidence');
const messageId = mintId('ConversationItem');
const laterId = mintId('ConversationItem');

describe('nextActionAfterCrash', () => {
  it('resumes, continues from the handoff or starts over after a crash, and keeps verification', () => {
    const rows: [string, NextAction, string | null, HandoffDto | null, NextAction['kind']][] = [
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
    ];
    for (const [name, previous, providerSessionId, latest, kind] of rows) {
      expect.soft(nextActionAfterCrash(previous, providerSessionId, latest).kind, name).toBe(kind);
    }
  });

  it("keeps the builder's input, a fix, a revise, uncommitted files, a merge and a Ready page across a crash", () => {
    const rows: [string, NextAction, string | null, NextAction][] = [
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
        { kind: 'fix', evidenceId, providerSessionId: null },
        'p1',
        { kind: 'fix', evidenceId, providerSessionId: null },
      ],
      [
        'keeps a revise with the step that rejected',
        { kind: 'revise', reviewStep: 1, providerSessionId: null },
        'p1',
        { kind: 'revise', reviewStep: 1, providerSessionId: null },
      ],
      [
        'sends a revise that resumed its step’s session fresh after a crash',
        { kind: 'revise', reviewStep: 1, providerSessionId: 'p-build' },
        'p-build',
        { kind: 'revise', reviewStep: 1, providerSessionId: null },
      ],
      [
        'keeps a fresh revise as it is, whatever session crashed',
        { kind: 'revise', reviewStep: 1, providerSessionId: null },
        'p-fix',
        { kind: 'revise', reviewStep: 1, providerSessionId: null },
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
      [
        "keeps a Ready page of a pass on its item: the builder's next message starts its turn",
        { kind: 'pass_review', inboxId },
        'p1',
        { kind: 'pass_review', inboxId },
      ],
    ];
    for (const [name, previous, providerSessionId, expected] of rows) {
      expect
        .soft(nextActionAfterCrash(previous, providerSessionId, handoff), name)
        .toEqual(expected);
    }
  });
});

describe('nextActionOnAnotherAccount', () => {
  it('starts what would resume a session on the other account fresh, and leaves every other action alone', () => {
    const rows: [string, NextAction, HandoffDto | null, EvidenceId | null, NextAction][] = [
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
        { kind: 'fix', evidenceId, providerSessionId: null },
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
        { kind: 'revise', reviewStep: 1, providerSessionId: null },
        handoff,
        null,
        { kind: 'revise', reviewStep: 1, providerSessionId: null },
      ],
      [
        'starts a revise that would resume a session on another account fresh',
        { kind: 'revise', reviewStep: 1, providerSessionId: 'p-build' },
        handoff,
        null,
        { kind: 'revise', reviewStep: 1, providerSessionId: null },
      ],
      [
        'leaves a fix alone',
        { kind: 'fix', evidenceId, providerSessionId: null },
        handoff,
        evidenceId,
        { kind: 'fix', evidenceId, providerSessionId: null },
      ],
      [
        'leaves a Ready page of a pass alone',
        { kind: 'pass_review', inboxId },
        handoff,
        null,
        { kind: 'pass_review', inboxId },
      ],
    ];
    for (const [name, previous, latest, failedGate, expected] of rows) {
      expect.soft(nextActionOnAnotherAccount(previous, latest, failedGate), name).toEqual(expected);
    }
  });
});

describe('withUndelivered', () => {
  it('turns an action into the message its session never took, unless the action already carries builder input or work', () => {
    const rows: [string, NextAction, TaskMessageId | null, NextAction, (string | null)?][] = [
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
        'keeps the message a feedback was started for, which an older one does not displace',
        { kind: 'feedback', messageId: laterId, providerSessionId: 'p1' },
        messageId,
        { kind: 'feedback', messageId: laterId, providerSessionId: 'p1' },
      ],
      [
        'keeps an answer, whose session is handed the message after it',
        { kind: 'answer', inboxId, providerSessionId: 'p1' },
        messageId,
        { kind: 'answer', inboxId, providerSessionId: 'p1' },
      ],
      [
        'keeps a revise that resumes its step’s session',
        { kind: 'revise', reviewStep: 1, providerSessionId: 'p-build' },
        messageId,
        { kind: 'revise', reviewStep: 1, providerSessionId: 'p-build' },
      ],
      ['keeps verification', { kind: 'verify' }, messageId, { kind: 'verify' }],
      [
        'keeps a fix',
        { kind: 'fix', evidenceId, providerSessionId: null },
        messageId,
        { kind: 'fix', evidenceId, providerSessionId: null },
      ],
      [
        'leaves a Ready page of a pass on its item when every message was taken',
        { kind: 'pass_review', inboxId },
        null,
        { kind: 'pass_review', inboxId },
        'p1',
      ],
      [
        "turns a Ready page whose session ended with the builder's message untaken into that message, resuming the session",
        { kind: 'pass_review', inboxId },
        messageId,
        { kind: 'feedback', messageId, providerSessionId: 'p1' },
        'p1',
      ],
      [
        'turns a Ready page with an untaken message and no session to resume into that message, fresh',
        { kind: 'pass_review', inboxId },
        messageId,
        { kind: 'feedback', messageId, providerSessionId: null },
      ],
    ];
    for (const [name, next, undelivered, expected, ended] of rows) {
      expect.soft(withUndelivered(next, undelivered, ended), name).toEqual(expected);
    }
  });
});

describe('keepingFeedback', () => {
  it("keeps the builder's message across a stop, resuming the session that stopped if it started", () => {
    const resume: NextAction = {
      kind: 'resume',
      providerSessionId: 'p2',
      reason: 'the usage limit reset',
    };
    const rows: [string, NextAction, NextAction, NextAction][] = [
      ['leaves an action without a message as the stop made it', { kind: 'start' }, resume, resume],
      [
        'keeps the message, resuming the session that stopped',
        { kind: 'feedback', messageId, providerSessionId: null },
        resume,
        { kind: 'feedback', messageId, providerSessionId: 'p2' },
      ],
      [
        'keeps the message and the session it would resume when the stopped one never started',
        { kind: 'feedback', messageId, providerSessionId: 'p1' },
        { kind: 'start' },
        { kind: 'feedback', messageId, providerSessionId: 'p1' },
      ],
    ];
    for (const [name, previous, stopped, expected] of rows) {
      expect.soft(keepingFeedback(previous, stopped), name).toEqual(expected);
    }
  });
});

describe('resumedSessionOf', () => {
  it('names the session a revise resumes, and none for a fresh revise or a gate fix', () => {
    const rows: [string, NextAction, string | null][] = [
      [
        'names the session a revise resumes',
        { kind: 'revise', reviewStep: 1, providerSessionId: 'p-build' },
        'p-build',
      ],
      [
        'names none for a fresh revise',
        { kind: 'revise', reviewStep: 1, providerSessionId: null },
        null,
      ],
      ['names none for a gate fix', { kind: 'fix', evidenceId, providerSessionId: null }, null],
    ];
    for (const [name, action, expected] of rows) {
      expect.soft(resumedSessionOf(action), name).toBe(expected);
    }
  });
});
