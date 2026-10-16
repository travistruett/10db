import type { PermissionRuleDto, ProjectDto } from '@10db/contracts';
import { splitCommand, stringField, stripCommandPrefixes } from '../guard';

/** Allow rules injected into every managed session. The guard still checks claims. */
export function baseAllowedTools(project: Pick<ProjectDto, 'gateCommand'>): string[] {
  return [
    'Read',
    'Glob',
    'Grep',
    'LS',
    'Edit',
    'Write',
    'MultiEdit',
    'NotebookEdit',
    'TodoWrite',
    'mcp__10db__*',
    `Bash(${project.gateCommand})`,
    'Bash(git status:*)',
    'Bash(git diff:*)',
    'Bash(git log:*)',
    'Bash(git show:*)',
    'Bash(ls:*)',
    'Bash(pwd)',
  ];
}

/** One normalized line per command segment, including substitution bodies. */
function segmentLines(command: string): string[] {
  return splitCommand(command).map((s) => stripCommandPrefixes(s.words).join(' '));
}

function startsWithWords(line: string, prefix: string): boolean {
  return line === prefix || line.startsWith(`${prefix} `);
}

function bashRuleMatches(rule: string, line: string): boolean {
  if (rule.endsWith(':*')) return startsWithWords(line, rule.slice(0, -2));
  return line === rule;
}

/** Whether an allow-list entry (`Name`, `prefix*`, `Bash(cmd)`, `Bash(prefix:*)`) permits the call. */
export function matchesAllowedTool(
  toolName: string,
  input: unknown,
  allowed: readonly string[],
): boolean {
  for (const entry of allowed) {
    const bashRule = /^Bash\((.+)\)$/.exec(entry)?.[1];
    if (bashRule !== undefined) {
      const command = toolName === 'Bash' ? stringField(input, 'command') : null;
      if (command === null) continue;
      const lines = segmentLines(command);
      if (lines.length > 0 && lines.every((line) => bashRuleMatches(bashRule, line))) return true;
      continue;
    }
    if (entry.endsWith('*') ? toolName.startsWith(entry.slice(0, -1)) : toolName === entry)
      return true;
  }
  return false;
}

/** First word, plus the subcommand when the second word is not a flag: "docker compose", "curl". */
export function commandPrefix(command: string): string {
  const words = stripCommandPrefixes(splitCommand(command)[0]?.words ?? []);
  const [first = '', second] = words;
  return second !== undefined &&
    !second.startsWith('-') &&
    !second.includes('/') &&
    !second.includes(':')
    ? `${first} ${second}`
    : first;
}

/** The stored rule that permits the call, if any; a Bash pattern must cover every segment. */
export function matchPermissionRule(
  req: { readonly toolName: string; readonly input: unknown },
  rules: readonly PermissionRuleDto[],
): PermissionRuleDto | undefined {
  return rules.find((rule) => {
    if (rule.toolName !== req.toolName) return false;
    const pattern = rule.pattern;
    if (pattern === null) return true;
    const command = stringField(req.input, 'command');
    if (command === null) return false;
    const lines = segmentLines(command);
    return lines.length > 0 && lines.every((line) => startsWithWords(line, pattern));
  });
}
