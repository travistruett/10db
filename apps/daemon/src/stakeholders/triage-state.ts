import type { GoalDto, InboxItemDto, TaskDto } from '@10db/contracts';

/**
 * What the judge reads about a question card, as named JSON fields: the card, the lane's category and
 * topic, and the titles of the task and goal it was asked under.
 */
export function triageState(
  card: Pick<InboxItemDto, 'title' | 'body' | 'options' | 'category'>,
  topic: string | null,
  task: Pick<TaskDto, 'title'> | null,
  goal: Pick<GoalDto, 'title'> | null,
): string {
  return JSON.stringify({
    title: card.title,
    body: card.body,
    options: card.options.map((o) => o.label),
    category: card.category,
    topic,
    task: task?.title ?? null,
    goal: goal?.title ?? null,
  });
}
