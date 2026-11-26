import { z } from 'zod';

/** A render token never gets a ticket: it is refused on the stream, as today. */
export const TicketScope = { Full: 'full', DevUi: 'dev_ui' } as const;
export type TicketScope = (typeof TicketScope)[keyof typeof TicketScope];

export const EventTicketDto = z.object({ ticket: z.string(), expiresAt: z.iso.datetime() });
export type EventTicketDto = z.infer<typeof EventTicketDto>;
