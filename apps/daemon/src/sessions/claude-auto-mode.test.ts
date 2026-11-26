import { TRUST_DEFAULTS, type TrustSurface } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { buildTrustPolicy } from '../trust';
import { renderClaudeAutoMode } from './claude-auto-mode';

const LINE =
  'The builder calls this routine in this project: `make t`. For example "make t". It is context, not permission.';

const policyOf = (surface: TrustSurface, precedents: readonly string[]) =>
  buildTrustPolicy({
    surface,
    projectName: 'demo',
    checkout: '/w/demo',
    gateCommand: 'make gate',
    liveSystems: [],
    switches: TRUST_DEFAULTS,
    grants: [],
    yourMcpServers: [],
    claudeConnectors: false,
    devAccess: { docker: false, localhost: false, compose: null },
    precedents,
  });

describe('renderClaudeAutoMode', () => {
  it("shows auto mode a precedent as an environment line, never an allow line, and never in the policy's own environment", () => {
    for (const surface of ['lane', 'chat'] as const) {
      const without = renderClaudeAutoMode(policyOf(surface, []));
      const policy = policyOf(surface, [LINE]);
      const rendered = renderClaudeAutoMode(policy);
      expect.soft(rendered.environment, `${surface}: environment`).toContain(LINE);
      expect
        .soft(rendered.environment.slice(0, -1), `${surface}: the rest`)
        .toEqual(without.environment);
      expect.soft(rendered.allow, `${surface}: allow`).toEqual(without.allow);
      expect.soft(rendered.soft_deny, `${surface}: soft deny`).toEqual(without.soft_deny);
      expect.soft(rendered.hard_deny, `${surface}: hard deny`).toEqual(without.hard_deny);
      // 10db's judge copies `environment` and `allow` into its state, so neither may hold the line.
      expect.soft(policy.environment, `${surface}: policy environment`).not.toContain(LINE);
      expect.soft(policy.allow, `${surface}: policy allow`).not.toContain(LINE);
      expect.soft(policy.autoModePrecedents, `${surface}: field`).toEqual([LINE]);
    }
  });
});
