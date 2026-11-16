import { mintId } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import {
  closedId,
  parseClosed,
  popClosed,
  pushClosed,
  takeClosed,
  type ClosedChat,
  type ClosedTab,
} from './closed-tabs';

const entry = (position: number, archived?: true): ClosedChat => ({
  chatId: mintId('Chat'),
  projectId: mintId('Project'),
  title: 'A session',
  position,
  ...(archived === undefined ? {} : { archived }),
});

describe('closed tabs', () => {
  it('keeps five, newest first, each with its position, when six are pushed', () => {
    const entries = [0, 1, 2, 3, 4, 5].map((p) => entry(p));
    const stack = entries.reduce<readonly ClosedTab[]>(pushClosed, []);
    expect(stack.map((e) => e.position)).toEqual([5, 4, 3, 2, 1]);
  });
  it('takes a chat from the middle and returns its position', () => {
    const [a, b, c] = [entry(0), entry(1), entry(2)] as [ClosedChat, ClosedChat, ClosedChat];
    const stack = [a, b, c].reduce<readonly ClosedTab[]>(pushClosed, []);
    const { entry: taken, rest } = takeClosed(stack, b.chatId);
    expect(taken?.position).toBe(1);
    expect(rest.map(closedId)).toEqual([c.chatId, a.chatId]);
  });
  it('pops the newest', () => {
    const [a, b] = [entry(0), entry(1)] as [ClosedChat, ClosedChat];
    const stack = [a, b].reduce<readonly ClosedTab[]>(pushClosed, []);
    expect(popClosed(stack).entry?.position).toBe(b.position);
    expect(popClosed([]).entry).toBeNull();
  });
  it('keeps the archived mark through a push and a take', () => {
    const archived = entry(3, true);
    const { entry: taken } = takeClosed(pushClosed([], archived), archived.chatId);
    expect(taken !== null && 'archived' in taken && taken.archived).toBe(true);
  });
  it('moves a chat closed again to the top instead of listing it twice', () => {
    const a = entry(0);
    const stack = pushClosed(pushClosed(pushClosed([], a), entry(1)), { ...a, position: 4 });
    expect(stack.map((e) => e.position)).toEqual([4, 1]);
  });
  it.each(['{', 'null', '[{"chatId":"nope","position":1}]', '[{"position":-1}]'])(
    'reads a corrupt store (%s) as empty',
    (raw) => {
      expect(parseClosed(raw)).toEqual([]);
    },
  );
});
