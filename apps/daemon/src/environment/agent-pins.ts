/**
 * The agent CLIs 10db runs: each at one pinned release, fetched from npm and checked against the
 * checksum recorded here. A release is adopted only by changing a version and its checksum together,
 * after the tool's live test passes (`TENDB_LIVE_CODEX=1 test/codex.live.test.ts`,
 * `TENDB_LIVE_CLAUDE=1 src/sessions/claude-adapter.live.test.ts`). Renovate opens that change
 * (`renovate.json`); the two lines of each pin stay adjacent so its pattern finds both.
 */

/** The Codex release the ChatGPT-plan checks and the app-server protocol 10db reads were verified on. */
export const CODEX_VERIFIED_ON = '0.167.0';
export const CODEX_SHA512 =
  'sha512-7YtMDZX/jbWH9+fCVQg7BVsov8WvBzu4iuedXJEDlUdZxaTrYX2bEQwHIn3p0gxgSMfm30HGK9+bZm1aGSZaHw==';

/** The Claude Code release the account variables and `accountInfo()` fields were verified on (spike 12). */
export const CLAUDE_CODE_VERIFIED_ON = '2.1.302';
export const CLAUDE_CODE_SHA512 =
  'sha512-h0MlQtldJnHXdPB6KGQ6rYQocvNTEXBI+NW4791OD2mIZcq6fHrV4PsM+XK297OL0+wVENlDHtlBj1BL/3S52A==';

export const AgentTool = { Claude: 'claude', Codex: 'codex' } as const;
export type AgentTool = (typeof AgentTool)[keyof typeof AgentTool];

/** One release 10db fetches, checks against a recorded checksum and runs from its own read-only copy. */
export interface PinnedRelease {
  /** The copy's folder name starts with it: `<tool>-<version>-<platform>`. */
  readonly tool: string;
  /** What the builder reads: "Claude Code", "Codex", "Chromium for pictures". */
  readonly label: string;
  readonly version: string;
  /** The download's checksum as npm records it: `sha512-` and the base64 digest. */
  readonly sha512: string;
  readonly tarballUrl: string;
  /** How much of the download is kept: the member to extract and the leading path parts it drops. */
  readonly member: string;
  readonly strip: number;
  /** The executable inside what is kept. */
  readonly executable: string;
}

export interface AgentPin extends PinnedRelease {
  readonly tool: AgentTool;
  /** The registry document of the newest release, read to tell the builder a newer one is out. */
  readonly latestUrl: string;
}

/** The only platform a 10db release runs on (Apple Silicon); npm names its builds `darwin-arm64`. */
export const AGENT_PLATFORM = 'darwin-arm64';

export const AGENT_PINS: Readonly<Record<AgentTool, AgentPin>> = {
  [AgentTool.Codex]: {
    tool: AgentTool.Codex,
    label: 'Codex',
    version: CODEX_VERIFIED_ON,
    sha512: CODEX_SHA512,
    tarballUrl: `https://registry.npmjs.org/@openai/codex/-/codex-${CODEX_VERIFIED_ON}-${AGENT_PLATFORM}.tgz`,
    latestUrl: 'https://registry.npmjs.org/@openai/codex/latest',
    member: 'package/vendor/aarch64-apple-darwin',
    strip: 3,
    executable: 'bin/codex',
  },
  [AgentTool.Claude]: {
    tool: AgentTool.Claude,
    label: 'Claude Code',
    version: CLAUDE_CODE_VERIFIED_ON,
    sha512: CLAUDE_CODE_SHA512,
    tarballUrl: `https://registry.npmjs.org/@anthropic-ai/claude-code-${AGENT_PLATFORM}/-/claude-code-${AGENT_PLATFORM}-${CLAUDE_CODE_VERIFIED_ON}.tgz`,
    latestUrl: 'https://registry.npmjs.org/@anthropic-ai/claude-code/latest',
    member: 'package/claude',
    strip: 1,
    executable: 'claude',
  },
};
