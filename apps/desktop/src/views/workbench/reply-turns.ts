import type { PassTurnWithFilesDto, TaskMessageDto } from '@10db/contracts';

/**
 * The turn an agent's reply ends: the reply's task's latest turn that started at or before it. A reply
 * is written as its turn ends, so the turn that started last before it is the one it answers.
 */
export function turnOfReply(
  reply: TaskMessageDto,
  turns: readonly PassTurnWithFilesDto[],
): PassTurnWithFilesDto | null {
  const at = Date.parse(reply.createdAt);
  return turns.reduce<PassTurnWithFilesDto | null>((found, turn) => {
    if (turn.taskId !== reply.taskId || Date.parse(turn.startedAt) > at) return found;
    return found === null || turn.startedAt > found.startedAt ? turn : found;
  }, null);
}
