import type { ChatDto } from '@10db/contracts';

/**
 * The dimmed line under a session's title, saying what the session is (sessions UI spec §4). A chat reads
 * the project; its writes in Your folder, and the lines that say so, come with the folder hold.
 */
export function kindLine(_chat: ChatDto, projectName: string): string {
  return `Chat · reads ${projectName}`;
}
