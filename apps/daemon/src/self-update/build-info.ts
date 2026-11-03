import { readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { CommitSha } from '@10db/contracts';

/** Written beside `daemon.mjs` by `scripts/build.ts`: the commit the bundle was built from. */
export const BUILD_INFO_FILE = 'build-info.json';

export interface BuildInfo {
  /** The commit this bundle was built from. */
  readonly commit: string;
  /**
   * The GitHub repository (`owner/name`) the build ran for: `GITHUB_REPOSITORY`, baked in by
   * `scripts/build.ts`. It is the only repository the app updates from; null when none was baked in.
   */
  readonly repository: string | null;
  /** The folder holding `scripts/release/install-app.sh`, beside the bundle. */
  readonly releaseDir: string;
  /**
   * True when the bundle runs from `10db.app` in the Applications folder, the one place the install
   * script puts an app, and knows its repository. Any other copy shows its commit but never
   * replaces itself.
   */
  readonly updatable: boolean;
}

/** An `owner/name` pair that cannot be taken for an option by gh. */
export const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9._-]+$/;

/** What the bundle in `bundleDir` was built from, or null for a run from source or a bad file. */
export function readBuildInfo(bundleDir: string, applications = '/Applications'): BuildInfo | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(bundleDir, BUILD_INFO_FILE), 'utf8'));
  } catch {
    return null;
  }
  const commit =
    typeof parsed === 'object' && parsed !== null && 'commit' in parsed
      ? CommitSha.safeParse(parsed.commit)
      : null;
  if (!commit?.success) return null;
  const baked =
    typeof parsed === 'object' && parsed !== null && 'repository' in parsed
      ? parsed.repository
      : undefined;
  const repository = typeof baked === 'string' && REPOSITORY.test(baked) ? baked : null;
  return {
    commit: commit.data,
    repository,
    releaseDir: join(bundleDir, 'release'),
    updatable: repository !== null && bundleDir.startsWith(join(applications, '10db.app') + sep),
  };
}
