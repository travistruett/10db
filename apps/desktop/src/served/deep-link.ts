/**
 * A card a notification opened. The Inbox shows its list first; with a card named, the frame shows that card
 * instead, once.
 */
let pending: string | null = null;

export function openCardDirectly(id: string): void {
  pending = id;
}

/** Whether a card was named since the last call; reading it clears it. */
export function takeDirectCard(): boolean {
  const named = pending !== null;
  pending = null;
  return named;
}
