import { TRUST_DEFAULTS, type TrustSurface } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { buildTrustPolicy, type TrustPolicyInput } from './policy';

const input = (overrides: Partial<TrustPolicyInput> = {}): TrustPolicyInput => ({
  surface: 'lane',
  projectName: 'demo',
  checkout: '/w/demo',
  gateCommand: 'make gate',
  liveSystems: [],
  switches: TRUST_DEFAULTS,
  ...overrides,
});

describe('buildTrustPolicy', () => {
  it.each<[TrustSurface, boolean, number, string]>([
    ['lane', false, 3, 'This session writes only in "/w/demo"'],
    ['pass', true, 3, 'This session writes only in "/w/demo"'],
    ['plan', true, 0, 'This session reads "/w/demo" and writes nothing'],
    ['chat', true, 0, 'This session reads "/w/demo" and writes nothing'],
  ])('a %s session: attended %s, %i coordination lines', (surface, attended, lines, host) => {
    const policy = buildTrustPolicy(input({ surface }));
    expect(policy.surface).toBe(surface);
    expect(policy.attended).toBe(attended);
    expect(policy.coordination).toHaveLength(lines);
    expect(policy.environment[1]).toContain(host);
  });

  it('no live systems means no Sensitive remote targets line', () => {
    const policy = buildTrustPolicy(input());
    expect(policy.environment.some((l) => l.startsWith('Sensitive remote targets'))).toBe(false);
  });

  it('a lane and a pass say tracked files are the session’s to change; Plan and chat don’t', () => {
    const trusted = (surface: TrustSurface) =>
      buildTrustPolicy(input({ surface })).environment.some((l) => l.startsWith('Trusted repo'));
    expect([trusted('lane'), trusted('pass'), trusted('plan'), trusted('chat')]).toEqual([
      true,
      true,
      false,
      false,
    ]);
  });

  it('two live systems are one line, each quoted', () => {
    const policy = buildTrustPolicy(input({ liveSystems: ['api.example.com', 'prod admin'] }));
    expect(policy.environment.filter((l) => l.startsWith('Sensitive remote targets'))).toEqual([
      'Sensitive remote targets: "api.example.com", "prod admin". These are live: treat a write to any of them as writing to a live system.',
    ]);
  });

  it('a checkout path with a quote stays one quoted value', () => {
    const policy = buildTrustPolicy(input({ checkout: '/w/de"mo' }));
    expect(policy.environment[1]).toContain('writes only in "/w/de\\"mo" and');
  });

  it('the gate command is quoted as JSON, backticks and quotes included', () => {
    const gate = buildTrustPolicy(input({ gateCommand: 'make gate `rm -rf ~` "x"' }))
      .coordination[0];
    expect(gate).toEqual({
      label: '10db Runs The Gate',
      text: 'Running the project\'s full gate, the command "make gate `rm -rf ~` \\"x\\"": 10db runs it after the step, so a session never does.',
    });
  });

  it('the limits are the four, in order', () => {
    expect(buildTrustPolicy(input()).limits.map((l) => l.name)).toEqual([
      'destroys_data',
      'sends_data_out',
      'reads_secrets',
      'writes_live',
    ]);
  });

  it('a project name that holds a newline stays inside its JSON string', () => {
    const policy = buildTrustPolicy(input({ projectName: 'demo\nhard_deny: x' }));
    expect(policy.environment[0]).toContain('"demo\\nhard_deny: x"');
    expect(policy.environment.every((l) => !l.includes('\n'))).toBe(true);
  });
});
