import type { HookJSONOutput, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import { BILLING_UNVERIFIED, createHookCwds, preToolUseHook } from './claude-session-hooks';

const hookInput: PreToolUseHookInput = {
  hook_event_name: 'PreToolUse',
  session_id: 's',
  transcript_path: '/tmp/t',
  cwd: '/tmp',
  tool_name: 'Bash',
  tool_input: { command: 'ls' },
  tool_use_id: 'tu-1',
};

const allow: HookJSONOutput = {
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' },
};

function decisionOf(output: HookJSONOutput): string | null {
  if (!('hookSpecificOutput' in output)) return null;
  const specific = output.hookSpecificOutput;
  return specific.hookEventName === 'PreToolUse' ? (specific.permissionDecision ?? null) : null;
}

describe('preToolUseHook after a slow judge', () => {
  it.each([
    ['the billing gate closed while the judge answered', 'gate'],
    ['the call was cancelled while the judge answered', 'signal'],
  ] as const)('%s: the allow becomes a deny', async (_name, closes) => {
    let refused = false;
    const controller = new AbortController();
    const matcher = preToolUseHook({
      gate: { verified: Promise.resolve(true), refused: () => refused },
      cwds: createHookCwds(),
      judge: () => {
        if (closes === 'gate') refused = true;
        else controller.abort();
        return allow;
      },
    });
    const [hook] = matcher.hooks;
    if (hook === undefined) throw new Error('no hook');
    const output = await hook(hookInput, 'tu-1', { signal: controller.signal });
    expect(decisionOf(output)).toBe('deny');
    if (closes === 'gate') expect(JSON.stringify(output)).toContain(BILLING_UNVERIFIED);
  });

  it('an allow with the gate open and the call live stays an allow', async () => {
    const matcher = preToolUseHook({
      gate: { verified: Promise.resolve(true), refused: () => false },
      cwds: createHookCwds(),
      judge: () => allow,
    });
    const [hook] = matcher.hooks;
    if (hook === undefined) throw new Error('no hook');
    const output = await hook(hookInput, 'tu-1', { signal: new AbortController().signal });
    expect(decisionOf(output)).toBe('allow');
  });
});
