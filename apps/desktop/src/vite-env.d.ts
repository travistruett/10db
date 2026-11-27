/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DAEMON_URL?: string;
  readonly VITE_DAEMON_TOKEN?: string;
  /** `'1'` under `pnpm dev:factory`: the dev server answers the factory daemon's connection. */
  readonly VITE_DAEMON_FACTORY?: string;
}
