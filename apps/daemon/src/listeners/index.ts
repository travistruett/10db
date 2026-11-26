/**
 * The daemon's two listeners and what each lets in, kept apart from `api/` so the devices and sharing modules can
 * name a listener without importing the API's entry point (and through it the whole daemon).
 */
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

/** The Host and Origin values one listener accepts. */
export interface ListenerAllowlists {
  readonly hosts: readonly string[];
  readonly origins: readonly string[];
}
