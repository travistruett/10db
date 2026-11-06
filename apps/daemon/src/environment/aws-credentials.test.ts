import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AwsCredentialsError, exportAwsCredentials } from './index';

const SECRET = 'wJalrXUtnFEMI-secret-value';
const TOKEN = 'IQoJb3JpZ2luX2Vj-session-token';
const ACCESS = 'fake-access-key-id';

let dir: string;
let bin: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), '10db-aws-'));
  bin = join(dir, 'bin');
  // A stand-in for the AWS CLI, which we don't own: it answers by FAKE_AWS_MODE and records nothing.
  const script = join(bin, 'aws');
  mkdirSync(bin);
  writeFileSync(
    script,
    `#!/bin/sh
if [ "$1 $2 $3 $4 $5 $6" != "configure export-credentials --profile $FAKE_AWS_PROFILE --format process" ]; then
  echo "unexpected arguments" >&2
  exit 64
fi
case "$FAKE_AWS_MODE" in
  full) printf '{"Version":1,"AccessKeyId":"${ACCESS}","SecretAccessKey":"${SECRET}","SessionToken":"${TOKEN}","Expiration":"2026-11-06T00:00:00+00:00"}' ;;
  bare) printf '{"Version":1,"AccessKeyId":"${ACCESS}","SecretAccessKey":"${SECRET}"}' ;;
  html) printf '<html>${SECRET}</html>' ;;
  badversion) printf '{"Version":2,"AccessKeyId":"${ACCESS}","SecretAccessKey":"${SECRET}"}' ;;
  expired) echo "Error loading SSO Token: Token for orgtools-prod has expired. To refresh, run aws sso login --profile orgtools-prod ${SECRET}" >&2; exit 255 ;;
  refresh) echo "The SSO session associated with this profile has expired or is otherwise invalid ${SECRET}" >&2; exit 255 ;;
  missingprofile) echo "The config profile (orgtools-prod) could not be found ${SECRET}" >&2; exit 255 ;;
  slow) exec sleep 60 ;;
esac
`,
  );
  chmodSync(script, 0o755);
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** The fake, as the only place 10db looks for the CLI. */
const FAKE = (): { candidates: string[] } => ({ candidates: [join(bin, 'aws')] });

const envFor = (mode: string, path = `${bin}:/usr/bin:/bin`): Record<string, string> => ({
  PATH: path,
  HOME: dir,
  FAKE_AWS_MODE: mode,
  FAKE_AWS_PROFILE: 'orgtools-prod',
});

describe('exportAwsCredentials', () => {
  it.each([
    {
      name: 'a session token and an expiry',
      mode: 'full',
      want: {
        AWS_ACCESS_KEY_ID: ACCESS,
        AWS_SECRET_ACCESS_KEY: SECRET,
        AWS_SESSION_TOKEN: TOKEN,
        AWS_CREDENTIAL_EXPIRATION: '2026-11-06T00:00:00+00:00',
      },
    },
    {
      name: 'no session token and no expiry',
      mode: 'bare',
      want: { AWS_ACCESS_KEY_ID: ACCESS, AWS_SECRET_ACCESS_KEY: SECRET },
    },
  ])('returns the env to add for $name', async ({ mode, want }) => {
    expect(await exportAwsCredentials('orgtools-prod', envFor(mode), FAKE())).toEqual(want);
  });

  it.each([
    { name: 'an answer that is not JSON', mode: 'html', signIn: false, says: 'orgtools-prod' },
    {
      name: 'an answer of another version',
      mode: 'badversion',
      signIn: false,
      says: 'orgtools-prod',
    },
    {
      name: 'a profile the CLI cannot find',
      mode: 'missingprofile',
      signIn: false,
      says: 'orgtools-prod',
    },
    {
      name: 'an expired SSO token',
      mode: 'expired',
      signIn: true,
      says: 'aws sso login --profile orgtools-prod',
    },
    {
      name: 'an SSO session that cannot refresh',
      mode: 'refresh',
      signIn: true,
      says: 'aws sso login --profile orgtools-prod',
    },
  ])('fails with a typed error for $name, with no credential in its message', async (row) => {
    const error = await exportAwsCredentials('orgtools-prod', envFor(row.mode), FAKE()).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(AwsCredentialsError);
    if (!(error instanceof AwsCredentialsError)) return;
    expect(error.name).toBe('AwsCredentialsError');
    expect(error.signIn).toBe(row.signIn);
    expect(error.message).toContain(row.says);
    for (const value of [SECRET, TOKEN, ACCESS]) expect(error.message).not.toContain(value);
  });

  it('runs only an aws installed in the fixed prefixes, never one a PATH entry names', async () => {
    // The login PATH can name a directory a lane writes; the fake aws on it must not run.
    const error = await exportAwsCredentials('orgtools-prod', envFor('full'), {
      candidates: [join(dir, 'nowhere', 'aws')],
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AwsCredentialsError);
    if (!(error instanceof AwsCredentialsError)) return;
    expect(error.message).toContain('AWS CLI (aws)');
    expect(error.message).toContain('/opt/homebrew/bin');
    expect(error.signIn).toBe(false);
  });

  it.each(['', '-x', 'a b', 'a;b', '$(x)'])('refuses the profile name %j', async (profile) => {
    const error = await exportAwsCredentials(profile, envFor('full'), FAKE()).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(AwsCredentialsError);
  });

  it('gives up on a CLI that does not answer, after the timeout it is given', async () => {
    const error = await exportAwsCredentials('orgtools-prod', envFor('slow'), {
      ...FAKE(),
      timeoutMs: 200,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AwsCredentialsError);
    if (error instanceof AwsCredentialsError) expect(error.message).toContain('orgtools-prod');
  });
});
