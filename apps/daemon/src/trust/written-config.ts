// T4 call 22: the config a lane can write that runs only after the builder approves it, or that the
// builder's own tools run: Claude Code's project settings, hooks, definitions and MCP servers, editor
// config, and mise's config, which mise reads in any folder of the checkout. Names are compared folded
// and composed, as APFS compares them.

const AT_ROOT = [
  /^\.claude\/settings[^/]*\.json$/,
  /^\.claude\/(hooks|skills|agents|commands)\//,
  /^\.mcp\.json$/,
  /^\.vscode\//,
  /^\.idea\//,
  /^\.config\/mise\//,
];

const ANYWHERE = [/(^|\/)mise(\.[^/]+)?\.toml$/, /(^|\/)\.mise\.toml$/, /(^|\/)\.tool-versions$/];

/** The paths among a run's changed paths that are config, in the order given. */
export function writtenConfig(paths: readonly string[]): string[] {
  return paths.filter((path) => {
    const folded = path.normalize('NFC').toLowerCase();
    return AT_ROOT.some((re) => re.test(folded)) || ANYWHERE.some((re) => re.test(folded));
  });
}
