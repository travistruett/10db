import { describe, expect, it } from 'vitest';
import type { TakeoverCommand } from '../sessions';
import { renderTakeover } from './render';

// Sessions spec §7.5: what the terminal runs is exactly the command: nothing in a value is shell syntax, no key is
// inlined, and no billing switch of the builder's shell survives.

const BASE: TakeoverCommand = {
  cwd: '/work/repo',
  unset: ['ANTHROPIC_API_KEY', 'CLAUDECODE'],
  unsetPrefixes: ['ANTHROPIC_DEFAULT_', 'TENDB_'],
  set: { CLAUDE_CONFIG_DIR: '/data/accounts/a/claude' },
  keychain: [],
  sources: [],
  argv: ['/pinned/claude', '--resume', 'abc-123'],
};

describe('the script and the line, as text', () => {
  it('reads a key through the Keychain into an exported variable, never writing a value', () => {
    const { script, line } = renderTakeover({
      ...BASE,
      keychain: [{ variable: 'AWS_BEARER_TOKEN_BEDROCK', account: 'account:k' }],
    });
    expect(script).toContain(
      "AWS_BEARER_TOKEN_BEDROCK=$(/usr/bin/security find-generic-password -s 10db -a 'account:k' -w)",
    );
    // The line quotes the whole body once more.
    expect(line).toContain(
      'AWS_BEARER_TOKEN_BEDROCK=$(/usr/bin/security find-generic-password -s 10db -a ',
    );
    expect(line).toContain('; export AWS_BEARER_TOKEN_BEDROCK;');
  });
});
