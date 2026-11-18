import { ConversationState } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { composerPhase, type ComposerPhaseInput } from './composer-phase';

const base: ComposerPhaseInput = {
  state: ConversationState.IdleWarm,
  hasText: false,
  steer: 'inject',
  project: 'ampsio',
  fresh: false,
  narrow: false,
  slashCommands: true,
};

const rows: readonly {
  readonly name: string;
  readonly input: Partial<ComposerPhaseInput>;
  readonly want: Partial<ReturnType<typeof composerPhase>>;
}[] = [
  {
    name: 'idle, nothing typed',
    input: {},
    want: {
      stop: null,
      send: 'default',
      placeholder: 'Reply…',
      hint: '↵ sends · ⇧↵ new line · Esc stops · / commands · @ files',
    },
  },
  { name: 'idle with text', input: { hasText: true }, want: { stop: null, send: 'filled' } },
  {
    name: 'a fresh tab',
    input: { fresh: true, state: ConversationState.IdleCold },
    want: { placeholder: 'Ask about ampsio…', hint: '↵ sends · ⇧↵ new line · @ files' },
  },
  {
    name: 'a session being moved to a branch',
    input: { movingTo: 'fix-login' },
    want: { placeholder: 'Moving to fix-login…' },
  },
  {
    name: 'no slash commands',
    input: { slashCommands: false },
    want: { hint: '↵ sends · ⇧↵ new line · Esc stops · @ files' },
  },
  {
    name: 'working, nothing typed',
    input: { state: ConversationState.Running },
    want: {
      stop: 'stop',
      send: 'hidden',
      placeholder: 'Add to this turn…',
      hint: '↵ adds to this turn · ⇧↵ new line',
    },
  },
  {
    name: 'working with text',
    input: { state: ConversationState.Running, hasText: true },
    want: { stop: 'stop_and_redo', send: 'filled' },
  },
  {
    name: 'waking up',
    input: { state: ConversationState.Starting },
    want: { stop: 'stop', placeholder: 'Add to this turn…' },
  },
  {
    name: 'waiting on a card',
    input: { state: ConversationState.WaitingCard, hasText: true },
    want: { stop: 'stop_and_redo' },
  },
  {
    name: 'working, an agent that queues',
    input: { state: ConversationState.Running, steer: 'queue' },
    want: {
      placeholder: 'Queue for the next turn…',
      hint: '↵ sends · ⇧↵ new line · Esc stops · / commands · @ files',
    },
  },
  {
    name: 'paused on the account',
    input: { state: ConversationState.PausedAccount },
    want: { stop: null, hint: 'Sends when the limit resets', placeholder: 'Reply…' },
  },
  {
    name: 'in the builder’s terminal',
    input: { state: ConversationState.TakenOver },
    want: {
      stop: null,
      placeholder: 'Held until you hand back…',
      hint: '↵ holds it · ⇧↵ new line · @ files',
    },
  },
  { name: 'narrow hides the hint', input: { narrow: true }, want: { hint: null } },
];

describe('composerPhase', () => {
  it.each(rows)('$name', ({ input, want }) => {
    expect(composerPhase({ ...base, ...input })).toMatchObject(want);
  });
});
