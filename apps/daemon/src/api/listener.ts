export const Listener = { Main: 'main', Share: 'share' } as const;
export type Listener = (typeof Listener)[keyof typeof Listener];

/** Hono bindings a listener's fetch wrapper passes as `env`. */
export interface ApiBindings {
  readonly listener?: Listener;
}

/** The listener a request arrived on; a missing binding is the main listener. */
export function listenerOf(env: ApiBindings | undefined): Listener {
  return env?.listener ?? Listener.Main;
}
