import { lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { YourMcpSource } from '@10db/contracts';
import { parse as parseToml } from 'smol-toml';
import { isEqualOrUnder, realOrSelf } from '../sandbox';
import { readRepoFileBytes, RepoConfigFileError } from '../sessions';
import {
  ClaudeFile,
  CodexFile,
  entriesOf,
  parseClaudeEntry,
  parseCodexEntry,
  type YourMcpEntry,
} from './your-mcp-entry';
import type { LeftOut } from './left-out';
import { readPluginMcp } from './plugin-mcp';

export type { YourMcpEntry } from './your-mcp-entry';

/** `~/.claude.json` holds the builder's project history too, and grows. */
export const YOUR_MCP_FILE_MAX_BYTES = 32 * 1024 * 1024;

const CLAUDE_JSON = '~/.claude.json';
const CODEX_CONFIG = '~/.codex/config.toml';

const sentence = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * One of the builder's files as text: null when there is none. It may be a link, as into a dotfiles
 * folder, but its real path must be a regular file within the cap and outside what a lane can write.
 */
function readBuilderFile(
  path: string,
  what: string,
  laneWritable: readonly string[],
): string | LeftOut | null {
  try {
    lstatSync(path);
  } catch {
    return null;
  }
  const none = 'so none of its MCP servers load.';
  let real: string;
  try {
    real = realpathSync.native(path);
  } catch {
    return { what, why: `It leads nowhere, ${none}` };
  }
  if (
    laneWritable.some(
      (root) => isEqualOrUnder(real, realOrSelf(root)) || isEqualOrUnder(real, root),
    )
  )
    return { what, why: `It leads into a folder an agent can write, ${none}` };
  try {
    const bytes = readRepoFileBytes(real, YOUR_MCP_FILE_MAX_BYTES);
    return bytes === null ? null : bytes.bytes.toString('utf8');
  } catch (error) {
    if (error instanceof RepoConfigFileError)
      return { what, why: `${sentence(error.message)}, ${none}` };
    throw error;
  }
}

/**
 * The builder's own MCP servers from `~/.claude.json` (its user-scope `mcpServers` only) and
 * `~/.codex/config.toml` (`mcp_servers`). Nothing else of either file is kept, and no reason or problem
 * quotes either file: a parser's own message carries fragments of the input, so it is dropped.
 */
export function readYourMcpConfig(input: {
  readonly home: string;
  readonly laneWritable: readonly string[];
  readonly plugins: readonly { readonly id: string; readonly installPath: string }[];
}): { entries: YourMcpEntry[]; fileProblems: LeftOut[] } {
  const entries: YourMcpEntry[] = [];
  const fileProblems: LeftOut[] = [];

  const claude = readBuilderFile(join(input.home, '.claude.json'), CLAUDE_JSON, input.laneWritable);
  if (typeof claude === 'string') {
    let json: unknown;
    try {
      json = JSON.parse(claude);
    } catch {
      json = undefined;
      fileProblems.push({
        what: CLAUDE_JSON,
        why: 'It is not valid JSON, so none of its MCP servers load.',
      });
    }
    const file = json === undefined ? null : ClaudeFile.safeParse(json);
    if (file?.success === false)
      fileProblems.push({
        what: CLAUDE_JSON,
        why: 'It is not a JSON object, so none of its MCP servers load.',
      });
    if (file?.success === true) {
      const read = entriesOf(
        file.data.mcpServers,
        YourMcpSource.ClaudeJson,
        parseClaudeEntry,
        CLAUDE_JSON,
      );
      entries.push(...read.entries);
      fileProblems.push(...read.problems);
    }
  } else if (claude !== null) fileProblems.push(claude);

  const codex = readBuilderFile(
    join(input.home, '.codex', 'config.toml'),
    CODEX_CONFIG,
    input.laneWritable,
  );
  if (typeof codex === 'string') {
    let toml: unknown;
    try {
      toml = parseToml(codex);
    } catch {
      toml = undefined;
      fileProblems.push({
        what: CODEX_CONFIG,
        why: 'It is not valid TOML, so none of its MCP servers load.',
      });
    }
    const file = toml === undefined ? null : CodexFile.safeParse(toml);
    if (file?.success === true) {
      const read = entriesOf(
        file.data.mcp_servers,
        YourMcpSource.CodexConfig,
        parseCodexEntry,
        CODEX_CONFIG,
      );
      entries.push(...read.entries);
      fileProblems.push(...read.problems);
    }
  } else if (codex !== null) fileProblems.push(codex);

  for (const plugin of input.plugins) entries.push(...readPluginMcp(plugin, input.laneWritable));

  return { entries, fileProblems };
}
