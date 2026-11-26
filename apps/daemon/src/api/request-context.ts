import type { TicketOwner } from '../devices';
import type { ApiBindings } from './listener';
import type { Principal } from './principal';

/** The Hono env of the API: the listener binding and what the guards and the credential set per request. */
export interface ApiEnv {
  Bindings: ApiBindings;
  Variables: {
    principal: Principal;
    /** Whether the request arrived by the share listener or carries a tailnet sign. */
    remote: boolean;
    /** The ticket a stream request spent; null otherwise. */
    ticketOwner: TicketOwner | null;
  };
}
