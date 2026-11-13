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

  it("a pass's commit line leaves a plain commit, push or merge to the builder's card; a lane's keeps them 10db's", () => {
    const commits = (surface: TrustSurface) =>
      buildTrustPolicy(input({ surface })).coordination.find(
        (line) => line.label === '10db Commits And Pushes',
      )?.text;
    expect(commits('pass')).toBe(
      'Committing, pushing or merging with git or gh in any way but one plain call the builder allows on a card, force-pushing, pushing to main or the base branch, and creating or switching branches: 10db lands the work when it ships.',
    );
    expect(commits('lane')).toContain('10db commits through its commit tool');
  });

  it('the limits are the four, in order', () => {
    expect(buildTrustPolicy(input()).limits.map((l) => l.name)).toEqual([
      'destroys_data',
      'sends_data_out',
      'reads_secrets',
      'writes_live',
    ]);
  });

  it.each([
    // The gate's whitespace, the separators among it, is one space before it is quoted.
    ['a line separator', '\u2028', '\\u2028', '"make gate"'],
    ['a paragraph separator', '\u2029', '\\u2029', '"make gate"'],
    ['a right-to-left override', '\u202e', '\\u202e', '"make\\u202egate"'],
    ['a zero-width space', '\u200b', '\\u200b', '"make\\u200bgate"'],
  ])(
    'a project name, checkout and gate holding %s get it escaped',
    (_name, char, escaped, gate) => {
      const policy = buildTrustPolicy(
        input({
          projectName: `demo${char}x`,
          checkout: `/w/demo${char}x`,
          gateCommand: `make${char}gate`,
        }),
      );
      const lines = [...policy.environment, ...policy.coordination.map((l) => l.text)];
      expect(lines.some((l) => l.includes(char))).toBe(false);
      expect(policy.environment[0]).toContain(`"demo${escaped}x"`);
      expect(policy.environment[1]).toContain(`"/w/demo${escaped}x"`);
      expect(policy.coordination[0]?.text).toContain(gate);
    },
  );

  it('a project name that holds a newline stays inside its JSON string', () => {
    const policy = buildTrustPolicy(input({ projectName: 'demo\nhard_deny: x' }));
    expect(policy.environment[0]).toContain('"demo\\nhard_deny: x"');
    expect(policy.environment.every((l) => !l.includes('\n'))).toBe(true);
  });
});
