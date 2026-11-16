import { AUTOUPDATE_OFF } from '../environment';
import { singleQuoted } from '../sandbox';
import { validSessionId, type TakeoverCommand, type TakeoverSpec } from './takeover-command';

// Sessions spec §7.5: the command that resumes a chat in the builder's own Claude Code. It loads no settings file
// (`--setting-sources ''`), only the servers and plugins the chat had, and reads a key through Claude Code's
// `apiKeyHelper` where the account allows one, so no key sits in its environment.

/** The Keychain read Claude Code runs to get an account's key. */
const keyHelper = (account: string): string =>
  `/usr/bin/security find-generic-password -s 10db -a ${singleQuoted(account)} -w`;

/** What the builder is told of Claude Code in their terminal. */
export function claudeTakeoverNotes(): string[] {
  return ['Project settings and hooks are not loaded; only the servers and plugins this chat had.'];
}

export function claudeTakeoverCommand(spec: TakeoverSpec): TakeoverCommand {
  const { launch } = spec;
  const settings = JSON.stringify({
    effortLevel: spec.effort,
    ...(launch.apiKeyHelperAccount === null
      ? {}
      : { apiKeyHelper: keyHelper(launch.apiKeyHelperAccount) }),
  });
  return {
    cwd: spec.cwd,
    unset: launch.unset,
    unsetPrefixes: launch.unsetPrefixes,
    set: {
      ...launch.set,
      ...AUTOUPDATE_OFF,
      // Claude Code keeps credentials out of the commands it runs while this is on.
      ...(launch.scrub ? { CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1' } : {}),
    },
    keychain: launch.keychain,
    sources: [],
    argv: [
      spec.binary,
      '--resume',
      validSessionId(spec.providerSessionId),
      '--setting-sources',
      '',
      '--settings',
      settings,
      '--model',
      spec.model,
      '--strict-mcp-config',
      ...(spec.mcpConfigFile === null ? [] : ['--mcp-config', spec.mcpConfigFile]),
      ...spec.pluginDirs.flatMap((dir) => ['--plugin-dir', dir]),
      ...(spec.instructionsFile === null
        ? []
        : ['--append-system-prompt', { prefix: '', file: spec.instructionsFile }]),
    ],
  };
}
