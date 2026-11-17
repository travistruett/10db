import type { ChatId } from '@10db/contracts';

/** The detail key of the card that asks where a session's work happens: the chat it asks about. */
export const CHAT_WORK_CARD_DETAIL = 'chatWork';

/** The fold key of a session's question, so a repeat finds the open card instead of raising another. */
export const chatWorkCardKey = (chatId: ChatId): string => `chat-work:${chatId}`;
