import { describe, expect, it } from 'vitest';
import {
  allSteps,
  environmentOf,
  readWorkflow,
  releaseWorkflowPaths,
  stepsOf,
  usesLines,
} from './workflows';
import { readRepoFile } from './workspace';

const MISE_ACTION = 'jdx/mise-action@';
// Any mention of the secrets context: `secrets.X`, `secrets['X']`, `toJSON(secrets)` and `secrets: inherit`.
const SECRETS_REFERENCE = /\bsecrets\b/;
// Tools the release build needs from mise.toml; the others (linters, scanners) stay uninstalled.
const RELEASE_MISE_TOOLS = 'node pnpm rust';
const ciMise = allSteps('.github/workflows/ci.yml').find(
  (step) => step.uses?.startsWith(MISE_ACTION) === true,
);
const ciMiseUses = ciMise?.uses;
const ciMiseVersion = ciMise?.with?.['version'];

it('ci.yml installs tools with jdx/mise-action at a pinned mise version, which the release workflows copy', () => {
  expect(ciMiseUses).toMatch(/^jdx\/mise-action@[0-9a-f]{40}$/);
  expect(ciMiseVersion).toMatch(/^\d{4}\.\d{1,2}\.\d+$/);
});

describe.each(Object.values(releaseWorkflowPaths))('%s', (path) => {
  const text = readRepoFile(path);
  const workflow = readWorkflow(path);
  const jobs = Object.entries(workflow.jobs);
  const steps = allSteps(path);
  const mise = steps.filter((step) => step.uses?.startsWith(MISE_ACTION) === true);

  it('pins every action to a full commit SHA with a version comment', () => {
    const uses = usesLines(text);
    expect(uses.length).toBeGreaterThan(0);
    expect(
      uses.filter((u) => !/@[0-9a-f]{40}$/.test(u.ref) || !/^# v\d+\.\d+\.\d+$/.test(u.comment)),
    ).toEqual([]);
  });

  it('never runs on pull_request_target', () => {
    expect(text).not.toContain('pull_request_target');
  });

  it('grants nothing at the top level and declares permissions on every job', () => {
    expect(workflow.permissions).toEqual({});
    expect(jobs.filter(([, job]) => job.permissions === undefined).map(([name]) => name)).toEqual(
      [],
    );
  });

  it('reads secrets only in jobs bound to the release or release-bot environment', () => {
    const leaking = jobs
      .filter(([, job]) => SECRETS_REFERENCE.test(JSON.stringify(job)))
      .filter(([, job]) => !['release', 'release-bot'].includes(environmentOf(job) ?? ''))
      .map(([name]) => name);
    expect(leaking).toEqual([]);
  });

  it('checks out without persisting credentials', () => {
    const checkouts = steps.filter((step) => step.uses?.startsWith('actions/checkout@') === true);
    expect(checkouts.filter((step) => step.with?.['persist-credentials'] !== false)).toEqual([]);
  });

  it('restores no caches, so a poisoned cache cannot reach a release build', () => {
    expect(text).not.toMatch(/actions\/cache@|Swatinem\/rust-cache@|cache: pnpm/);
    expect(mise.filter((step) => step.with?.['cache'] !== false)).toEqual([]);
  });

  it('installs only the mise tools the build needs', () => {
    expect(mise.map((step) => step.with?.['install_args'])).toEqual(
      mise.map(() => RELEASE_MISE_TOOLS),
    );
  });

  it('uses the same mise-action pin and mise version as ci.yml', () => {
    const drifted = mise.filter(
      (step) => step.uses !== ciMiseUses || step.with?.['version'] !== ciMiseVersion,
    );
    expect(drifted).toEqual([]);
  });
});

describe('release workflow', () => {
  const workflow = readWorkflow(releaseWorkflowPaths.release);
  const job = workflow.jobs['release'];
  const steps = stepsOf(job);
  const at = (needle: string): number =>
    steps.findIndex((step) => `${step.uses ?? ''}${step.run ?? ''}`.includes(needle));

  it('runs on v* tags only', () => {
    expect(workflow.on).toEqual({ push: { tags: ['v*'] } });
  });

  it('is one job, in the release environment, on an Apple Silicon runner', () => {
    expect(Object.keys(workflow.jobs)).toEqual(['release']);
    expect(environmentOf(job)).toBe('release');
    expect(job?.['runs-on']).toBe('macos-15');
  });

  it('grants only what signing, attesting and publishing need', () => {
    expect(job?.permissions).toEqual({
      attestations: 'write',
      contents: 'write',
      'id-token': 'write',
    });
  });

  it('checks the tag and the draft before building, and publishes last', () => {
    const order = [
      'check-version.mjs',
      '--json isDraft',
      'build-macos.sh signed',
      'actions/attest-build-provenance@',
      'gh release upload',
      '--draft=false',
    ].map(at);
    expect(
      order.every((index) => index >= 0),
      String(order),
    ).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(at('--draft=false')).toBe(steps.length - 1);
  });

  it('removes the API key file right after the build, whether or not it succeeded', () => {
    const removal = steps[at('build-macos.sh signed') + 1];
    expect(removal?.run).toBe('rm -f "$RUNNER_TEMP/AuthKey.p8"');
    expect(removal?.if).toBe('always()');
  });

  it('attests every file listed in SHA256SUMS', () => {
    expect(steps[at('actions/attest-build-provenance@')]?.with).toEqual({
      'subject-checksums': 'dist/release/SHA256SUMS',
    });
  });
});

describe('release-dry-run workflow', () => {
  const text = readRepoFile(releaseWorkflowPaths.dryRun);
  const workflow = readWorkflow(releaseWorkflowPaths.dryRun);

  it('runs only when dispatched by hand', () => {
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
  });

  it('can reach no secret, no environment and no release', () => {
    expect(text).not.toMatch(/\bsecrets\b|environment:|gh release|id-token/);
    expect(Object.values(workflow.jobs).map((job) => job.permissions)).toEqual([
      { contents: 'read' },
    ]);
  });

  it('builds unsigned and keeps the DMG as a workflow artifact', () => {
    expect(text).toContain('bash scripts/release/build-macos.sh unsigned');
    expect(text).toContain('actions/upload-artifact@');
  });
});

describe('build-macos.sh', () => {
  const script = readRepoFile('scripts/release/build-macos.sh');

  it('builds for Apple Silicon only', () => {
    expect(script).toContain('target=aarch64-apple-darwin');
    expect(script).not.toMatch(/x86_64|universal-apple-darwin/);
  });

  it('notarizes, staples and Gatekeeper-checks both the DMG and the app in signed mode', () => {
    for (const command of [
      'xcrun notarytool submit',
      'xcrun stapler staple "$dmg"',
      'xcrun stapler validate "$dmg"',
      'xcrun stapler validate "$app"',
      'spctl --assess --type open --context context:primary-signature --verbose=4 "$dmg"',
      'spctl --assess --type execute --verbose=4 "$app"',
    ]) {
      expect(script).toContain(command);
    }
  });

  it('checks every Mach-O in Contents/MacOS for arm64', () => {
    expect(script).toMatch(/for binary in "\$app"\/Contents\/MacOS\/\*/);
    expect(script).not.toContain('binaries[0]');
  });
});
