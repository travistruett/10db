import { mintId } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { minutesBeforeNow, passTurnWithFilesDto, taskMessageDto } from '../../test/pass-fixtures';
import { turnOfReply } from './reply-turns';

const taskId = mintId('Task');
const first = passTurnWithFilesDto({ taskId, seq: 1, startedAt: minutesBeforeNow(20) });
const second = passTurnWithFilesDto({ taskId, seq: 2, startedAt: minutesBeforeNow(8) });
const elsewhere = passTurnWithFilesDto({ seq: 3, startedAt: minutesBeforeNow(5) });

describe('turnOfReply', () => {
  it.each<{ name: string; repliedMinutesAgo: number; seq: number | null }>([
    { name: 'a reply before any turn has none', repliedMinutesAgo: 30, seq: null },
    { name: 'a reply during the first turn is the first turn’s', repliedMinutesAgo: 10, seq: 1 },
    { name: 'a reply as the second turn starts is the second’s', repliedMinutesAgo: 8, seq: 2 },
    { name: 'another task’s later turn is never a reply’s', repliedMinutesAgo: 1, seq: 2 },
  ])('$name', ({ repliedMinutesAgo, seq }) => {
    const reply = taskMessageDto(taskId, {
      author: 'agent',
      kind: 'reply',
      createdAt: minutesBeforeNow(repliedMinutesAgo),
    });
    expect(turnOfReply(reply, [second, elsewhere, first])?.seq ?? null).toBe(seq);
  });
});
