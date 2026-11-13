import type { PolicyLine, TrustPolicy } from '@10db/contracts';
import { z } from 'zod';

/**
 * Claude Code splices its built-in rules in where this entry stands. A list without it replaces them,
 * which would drop the defaults that block force pushes, publishes and `curl | bash`.
 */
const DEFAULTS = '$defaults';

const RuleList = z.tuple([z.literal(DEFAULTS)], z.string().min(1));

/**
 * The shape Claude Code reads from inline `settings.autoMode`: sentences its classifier weighs a call
 * against, `$defaults` first in each list. The SDK's settings type has no `autoMode`, so this validates it.
 */
export const ClaudeAutoModeSettings = z.strictObject({
  environment: RuleList,
  allow: RuleList,
  soft_deny: RuleList,
  hard_deny: RuleList,
  classifyAllShell: z.boolean().exactOptional(),
});
export type ClaudeAutoModeSettings = z.infer<typeof ClaudeAutoModeSettings>;

const rule = (line: PolicyLine): string => `${line.label}: ${line.text}`;

/**
 * A session's policy as auto mode's rules. Where a person is in the session a limit is a soft deny,
 * which their go-ahead for the exact action clears; where none is, a hard deny. The coordination lines
 * are hard everywhere: no go-ahead changes who runs the gate or commits.
 */
export function renderClaudeAutoMode(policy: TrustPolicy): ClaudeAutoModeSettings {
  const limits = policy.limits.map(rule);
  const coordination = policy.coordination.map(rule);
  return ClaudeAutoModeSettings.parse({
    environment: [DEFAULTS, ...policy.environment],
    allow: [DEFAULTS, ...policy.allow],
    soft_deny: policy.attended ? [DEFAULTS, ...limits] : [DEFAULTS],
    hard_deny: policy.attended
      ? [DEFAULTS, ...coordination]
      : [DEFAULTS, ...limits, ...coordination],
    // An allow rule would otherwise settle a narrow shell command before the classifier sees it.
    classifyAllShell: true,
  });
}
