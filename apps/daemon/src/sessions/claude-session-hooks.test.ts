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

describe('preToolUseHook tells who refused a call', () => {
  const deny: HookJSONOutput = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: 'no',
    },
  };
  it.each([
    ["a guard's deny is 10db's", deny, { by: '10db', reason: 'no', limit: null, soft: null }],
    [
      "a judge's limit is the judge's, final",
      { output: deny, judged: { limit: 'writes_live' } },
      { by: 'judge', reason: 'no', limit: 'writes_live', soft: false },
    ],
    [
      'a judge that named no limit says so',
      { output: deny, judged: { limit: null } },
      { by: 'judge', reason: 'no', limit: null, soft: false },
    ],
  ] as const)('%s', async (_name, answered, expected) => {
    const told: unknown[] = [];
    const matcher = preToolUseHook({
      gate: { verified: Promise.resolve(true), refused: () => false },
      cwds: createHookCwds(),
      judge: () => answered,
      onDenied: (id, denial) => told.push([id, denial]),
    });
    const [hook] = matcher.hooks;
    if (hook === undefined) throw new Error('no hook');
    await hook(hookInput, 'tu-1', { signal: new AbortController().signal });
    expect(told).toEqual([['tu-1', expected]]);
  });
});
