import { execFile } from 'node:child_process';
import { delimiter, isAbsolute } from 'node:path';
import { z } from 'zod';
import { firstExecutable, installCandidates, INSTALL_PREFIXES_TEXT } from '../git';

const EXPORT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 64 * 1024;
/** What an AWS profile name is made of; it also keeps a repo-declared name from reading as an option. */
const PROFILE_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.@:+=,/-]*$/;
/** How the AWS CLI words an expired or unrefreshable SSO login, matched loosely. */
const SIGN_IN_WORDING = /expired|\bsso\b|aws sso login|refresh/i;

/** The CLI's `--format process` answer (the `credential_process` contract). */
const ProcessCredentials = z.object({
  Version: z.literal(1),
  AccessKeyId: z.string().min(1),
  SecretAccessKey: z.string().min(1),
  SessionToken: z.string().min(1).optional(),
  Expiration: z.string().min(1).optional(),
});

/** Credentials for a profile could not be exported. The message names the profile and the problem, never a credential. */
export class AwsCredentialsError extends Error {
  override readonly name = 'AwsCredentialsError';
  /** True when the builder's SSO login has to be renewed with `aws sso login`. */
  readonly signIn: boolean;

  constructor(message: string, signIn = false) {
    super(message);
    this.signIn = signIn;
  }
}

/** Turns a profile of the builder's AWS config into the variables that make a process act as that one role. */
export type AwsCredentialsExporter = (
  profile: string,
  env: Readonly<Record<string, string>>,
  options?: {
    readonly timeoutMs?: number;
    /** Where the CLI is looked for, in order; the fixed install prefixes by default. */
    readonly candidates?: readonly string[];
  },
) => Promise<Record<string, string>>;

interface Spawned {
  readonly stdout: string;
  readonly stderr: string;
  readonly failure: { readonly code: unknown; readonly killed: boolean } | null;
}

function runAws(
  aws: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
  timeoutMs: number,
): Promise<Spawned> {
  return new Promise((resolve) => {
    execFile(
      aws,
      [...args],
      { env: { ...env }, timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, encoding: 'utf8' },
      (error, stdout, stderr) => {
        resolve({
          stdout,
          stderr,
          failure: error === null ? null : { code: error.code, killed: error.killed === true },
        });
      },
    );
  });
}

/** PATH without relative or empty entries: `aws` runs outside any sandbox, so nothing in a checkout may lead the lookup. */
function absolutePath(path: string | undefined): string {
  return (path ?? '')
    .split(delimiter)
    .filter((entry) => isAbsolute(entry))
    .join(delimiter);
}

/**
 * Runs `aws configure export-credentials --profile <profile> --format process` as the builder, outside
 * any sandbox, and returns the short-lived credentials of that one profile as the variables to hand a
 * process. The CLI is the first in the fixed install prefixes, never one the login PATH names, where a
 * lane could put one; `env` is the session env, whose HOME finds `~/.aws`. The SSO token
 * itself stays with the CLI: a process given only these variables acts as that role and cannot ask for another.
 */
export const exportAwsCredentials: AwsCredentialsExporter = async (profile, env, options = {}) => {
  if (!PROFILE_NAME.test(profile)) {
    throw new AwsCredentialsError(
      `The AWS profile name "${profile.replace(/[^\x20-\x7e]/g, '?')}" is not a valid profile name.`,
    );
  }
  const aws = firstExecutable(options.candidates ?? installCandidates('aws'));
  if (aws === null) {
    throw new AwsCredentialsError(
      `10db can't export AWS credentials for the profile "${profile}": the AWS CLI (aws) isn't installed in ${INSTALL_PREFIXES_TEXT}. Install it, then try again.`,
    );
  }
  const result = await runAws(
    aws,
    ['configure', 'export-credentials', '--profile', profile, '--format', 'process'],
    { ...env, PATH: absolutePath(env['PATH']) },
    options.timeoutMs ?? EXPORT_TIMEOUT_MS,
  );
  if (result.failure !== null) {
    if (result.failure.killed) {
      throw new AwsCredentialsError(
        `Exporting AWS credentials for the profile "${profile}" took too long and was stopped. If your AWS login has expired, run aws sso login --profile ${profile}, then try again.`,
      );
    }
    if (SIGN_IN_WORDING.test(result.stderr)) {
      throw new AwsCredentialsError(
        `The AWS login for the profile "${profile}" has expired. Run aws sso login --profile ${profile}, then try again.`,
        true,
      );
    }
    throw new AwsCredentialsError(
      `10db couldn't export AWS credentials for the profile "${profile}": the AWS CLI refused. Check that the profile exists in your AWS config.`,
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(result.stdout);
  } catch {
    json = null;
  }
  const parsed = ProcessCredentials.safeParse(json);
  if (!parsed.success) {
    throw new AwsCredentialsError(
      `The AWS CLI's credentials for the profile "${profile}" were not in the expected form.`,
    );
  }
  return {
    AWS_ACCESS_KEY_ID: parsed.data.AccessKeyId,
    AWS_SECRET_ACCESS_KEY: parsed.data.SecretAccessKey,
    ...(parsed.data.SessionToken === undefined
      ? {}
      : { AWS_SESSION_TOKEN: parsed.data.SessionToken }),
    ...(parsed.data.Expiration === undefined
      ? {}
      : { AWS_CREDENTIAL_EXPIRATION: parsed.data.Expiration }),
  };
};
