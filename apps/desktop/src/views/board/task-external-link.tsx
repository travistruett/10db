import type { TaskDto } from '@10db/contracts';
import { ExternalLink } from './pull-request-link';

/** The tracker issue a task was made from, as its id and a link to the issue; nothing for a task made by hand. */
export function TaskExternalLink({ task }: { readonly task: Pick<TaskDto, 'external'> }) {
  const { external } = task;
  if (external == null) return null;
  return <ExternalLink url={external.url} label={external.id} size="xs" />;
}
