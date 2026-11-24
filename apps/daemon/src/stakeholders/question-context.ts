import type { InboxItemId } from '@10db/contracts';
import { getInboxItem, getTask, inboxCardContext, targetTaskIds, type DbReader } from '@10db/db';
import { stakeholderOptions } from './compose';
import { draftContext } from './drafts';

const TITLE_LIMIT = 500;
const BODY_LIMIT = 2500;
const DESCRIPTION_LIMIT = 2000;
const CRITERIA_COUNT = 10;
const CRITERION_LIMIT = 300;
/** Conversation items read, from which the lane agent's last few messages are kept. */
const MESSAGES_READ = 6;
const LANE_MESSAGES = 3;
const LANE_MESSAGE_LIMIT = 1000;

/** Everything the answer writer may know, and nothing else: no files, other cards, knowledge or code. */
export interface QuestionContext {
  readonly card: {
    title: string;
    body: string;
    options: string[];
    recommendation: string | null;
  };
  readonly task: { title: string; description: string; acceptanceCriteria: string[] } | null;
  readonly goalTitle: string | null;
  /** The lane agent's own messages only; the builder's messages to the lane never reach the writer. */
  readonly laneMessages: readonly { text: string }[];
  readonly projectName: string;
  readonly builderName: string;
}

/** What the writer is told about a question's card, each field cut to a size a prompt can carry. */
export function questionContext(db: DbReader, cardId: InboxItemId): QuestionContext {
  const card = getInboxItem(db, cardId);
  const [taskId] = targetTaskIds(db, card.targets);
  const task = taskId === undefined ? null : getTask(db, taskId);
  const { projectName, goalTitle, builderName } = draftContext(db, card);
  return {
    card: {
      title: card.title.slice(0, TITLE_LIMIT),
      body: card.body.slice(0, BODY_LIMIT),
      options: stakeholderOptions(card).map((option) => option.label),
      recommendation: card.recommendation,
    },
    task:
      task === null
        ? null
        : {
            title: task.title.slice(0, TITLE_LIMIT),
            description: task.description.slice(0, DESCRIPTION_LIMIT),
            acceptanceCriteria: task.acceptanceCriteria
              .slice(0, CRITERIA_COUNT)
              .map((criterion) => criterion.slice(0, CRITERION_LIMIT)),
          },
    goalTitle,
    laneMessages: inboxCardContext(db, cardId, MESSAGES_READ)
      .messages.filter((message) => message.author === 'agent')
      .slice(-LANE_MESSAGES)
      .map((message) => ({ text: message.text.slice(0, LANE_MESSAGE_LIMIT) })),
    projectName,
    builderName,
  };
}
