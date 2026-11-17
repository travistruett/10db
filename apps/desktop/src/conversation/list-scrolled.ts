import { createContext, useContext } from 'react';

/**
 * How a conversation's list tells the frame around it that it is scrolled down from its start, so the
 * bar above it casts a shadow. Null outside a `ConversationLayout`.
 */
export const ListScrolledContext = createContext<((scrolled: boolean) => void) | null>(null);

export function useListScrolled(): ((scrolled: boolean) => void) | null {
  return useContext(ListScrolledContext);
}
