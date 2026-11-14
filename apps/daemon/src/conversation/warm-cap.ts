import type { ConversationId } from '@10db/contracts';

// Sessions spec §6.6: at most `cap` idle warm explore sessions app-wide.

/** The idle warm session to close past `cap`: the one idle longest, the first of a tie; else null. */
export function warmToClose(
  warm: readonly { readonly id: ConversationId; readonly idleSince: number }[],
  cap: number,
): ConversationId | null {
  if (warm.length <= cap) return null;
  let oldest = warm[0];
  for (const session of warm)
    if (oldest !== undefined && session.idleSince < oldest.idleSince) oldest = session;
  return oldest?.id ?? null;
}
