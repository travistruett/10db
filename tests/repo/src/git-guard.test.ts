import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createThrowawayRepo, type ThrowawayRepo } from './fixtures';
import { repoRoot } from './workspace';

const HOOK = resolve(repoRoot, '.claude/hooks/git-guard.mjs');

type Outcome = 'allow' | 'deny' | 'ask' | 'warn';

// Two throwaway repos on a feature branch: one with an empty index, one where another session has
// already staged other.ts. The hook reads the index of the cwd it is given.
let cleanRepo: ThrowawayRepo;
let dirtyRepo: ThrowawayRepo;
let clean: string;
let dirty: string;

function makeRepo(staged: string[]): ThrowawayRepo {
  const repo = createThrowawayRepo('10db-guard');
  mkdirSync(join(repo.dir, 'src'));
  for (const file of ['a.ts', 'b.ts', 'src/c.ts']) writeFileSync(join(repo.dir, file), 'x\n');
  for (const file of staged) repo.stage(file, 'x\n');
  return repo;
}

beforeAll(() => {
  cleanRepo = makeRepo([]);
  dirtyRepo = makeRepo(['other.ts']);
  clean = cleanRepo.dir;
  dirty = dirtyRepo.dir;
});

afterAll(() => {
  cleanRepo.remove();
  dirtyRepo.remove();
});

function runHook(
  stdin: string,
  env: Record<string, string> = {},
): { outcome: Outcome; reason: string; exit: number | null } {
  const result = spawnSync(process.execPath, [HOOK], {
    input: stdin,
    encoding: 'utf8',
    env: { PATH: process.env['PATH'] ?? '', ...env },
    cwd: repoRoot,
  });
  const out = result.stdout.trim();
  if (out === '') return { outcome: 'allow', reason: '', exit: result.status };
  const parsed = JSON.parse(out) as {
    hookSpecificOutput?: {
      permissionDecision?: 'deny' | 'ask';
      permissionDecisionReason?: string;
      additionalContext?: string;
    };
  };
  const specific = parsed.hookSpecificOutput ?? {};
  if (specific.permissionDecision) {
    return {
      outcome: specific.permissionDecision,
      reason: specific.permissionDecisionReason ?? '',
      exit: result.status,
    };
  }
  return { outcome: 'warn', reason: specific.additionalContext ?? '', exit: result.status };
}

const bash = (command: string, cwd: string): string =>
  JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    cwd,
    tool_input: { command },
  });

describe('git guard decisions', () => {
  it.each<[string, string, Outcome]>([
    ['explicit add then commit', "git add a.ts b.ts && git commit -m 'Add a and b'", 'allow'],
    ['commit naming paths after --', "git commit -m 'Fix' -- src/a.ts", 'allow'],
    ['read-only git', 'git status --short && git diff HEAD~1', 'allow'],
    ['non-git command', 'pnpm vitest run', 'allow'],
    ['add -A', 'git add -A', 'deny'],
    ['add dot', 'git add .', 'deny'],
    ['add --all', 'git add --all', 'deny'],
    ['add -u', 'git add -u', 'deny'],
    ['commit -a', "git commit -a -m 'x'", 'deny'],
    ['commit -am', "git commit -am 'x'", 'deny'],
    ['commit in its own call, after a separate add', "git commit -m 'x'", 'deny'],
    ['backtick in double-quoted message', 'git add a.ts && git commit -m "Use `pnpm`"', 'deny'],
    ['backtick in single-quoted message', "git add a.ts && git commit -m 'Use `pnpm`'", 'allow'],
    ['commit --no-verify', "git add a.ts && git commit --no-verify -m 'x'", 'deny'],
    ['commit -n', "git add a.ts && git commit -n -m 'x'", 'deny'],
    ['push --no-verify', 'git push --no-verify origin feat/x', 'deny'],
    ['LEFTHOOK=0 prefix', "git add a.ts && LEFTHOOK=0 git commit -m 'x'", 'deny'],
    ['export LEFTHOOK=false', 'export LEFTHOOK=false', 'deny'],
    ['hooksPath override', "git -c core.hooksPath=/dev/null commit -m 'x' -- a.ts", 'deny'],
    [
      'commit --no-verify after the message',
      "git add a.ts && git commit -m 'x' --no-verify",
      'deny',
    ],
    [
      'commit --no-verif, a prefix git accepts',
      "git add a.ts && git commit --no-verif -m 'x'",
      'deny',
    ],
    ['commit --no-v prefix', "git add a.ts && git commit --no-v -m 'x'", 'deny'],
    ['commit -nm', "git add a.ts && git commit -nm 'x'", 'deny'],
    ['push --no-verif prefix', 'git push --no-verif origin feat/x', 'deny'],
    ['config core.hooksPath', 'git config core.hooksPath /dev/null', 'deny'],
    ['config --local core.hooksPath', 'git config --local core.hooksPath .nohooks', 'deny'],
    ['config --unset core.hooksPath', 'git config --unset core.hooksPath', 'deny'],
    ['reading core.hooksPath', 'git config --get core.hooksPath', 'allow'],
    [
      '--config-env hooksPath',
      "git --config-env=core.hooksPath=HOME commit -m 'x' -- a.ts",
      'deny',
    ],
    [
      'GIT_CONFIG_* hooksPath',
      "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/x git commit -m 'x' -- a.ts",
      'deny',
    ],
    ['export GIT_CONFIG_PARAMETERS', 'export GIT_CONFIG_PARAMETERS=x', 'deny'],
    [
      'LEFTHOOK_EXCLUDE',
      "git add a.ts && LEFTHOOK_EXCLUDE=gitleaks,prettier git commit -m 'x'",
      'deny',
    ],
    ['LEFTHOOK_CONFIG', "git add a.ts && LEFTHOOK_CONFIG=/dev/null git commit -m 'x'", 'deny'],
    ['LEFTHOOK=1 is harmless', 'LEFTHOOK=1 pnpm install', 'allow'],
    ['bash -c wrapping a skip', 'bash -c "git commit --no-verify -m x -- a.ts"', 'deny'],
    ['eval wrapping a bulk add', "eval 'git add -A'", 'deny'],
    ['removing the hooks', 'rm -rf .git/hooks', 'ask'],
    ['lefthook uninstall', 'pnpm exec lefthook uninstall', 'ask'],
    ['filter-repo', 'git filter-repo --force', 'ask'],
    ['filter-repo version check', 'git filter-repo --version', 'allow'],
    ['admin merge', 'gh pr merge 12 --squash --admin', 'ask'],
    ['plain merge', 'gh pr merge 12 --squash', 'allow'],
    ['ruleset PUT', 'gh api -X PUT repos/o/r/rulesets/7 --input rs.json', 'ask'],
    ['ruleset POST implied by a field', 'gh api repos/o/r/rulesets -f name=x', 'ask'],
    ['reading rulesets', 'gh api repos/o/r/rulesets', 'allow'],
    ['environment delete', 'gh api --method DELETE repos/o/r/environments/release', 'ask'],
    ['secret set', 'gh secret set X --env release', 'ask'],
    ['github-settings', 'make github-settings', 'ask'],
    ['github-settings through node', 'node scripts/github-settings.mjs', 'ask'],
    ['github-settings through node, dot path', 'node ./scripts/github-settings.mjs', 'ask'],
    [
      'github-settings through node, absolute path',
      'node /x/10db/scripts/github-settings.mjs',
      'ask',
    ],
    ['github-settings run directly', './scripts/github-settings.mjs', 'ask'],
    ['github-settings from inside scripts/', 'cd scripts && node github-settings.mjs', 'ask'],
    [
      'github-settings behind a dot-dot path',
      'node ./scripts/../scripts/github-settings.mjs',
      'ask',
    ],
    ['github-settings behind a parent segment', 'node scripts/../github-settings.mjs', 'ask'],
    ['github-settings run directly from scripts/', './github-settings.mjs', 'ask'],
    ['github-settings through pnpm exec', 'pnpm exec node scripts/github-settings.mjs', 'ask'],
    ['staging the github-settings script', 'git add scripts/github-settings.mjs', 'allow'],
    ['reading the github-settings script', 'cat scripts/github-settings.mjs', 'allow'],
    ['repo settings PATCH', 'gh api -X PATCH repos/o/r -f private=false', 'ask'],
    ['repo settings implied by a field', 'gh api repos/o/r -f description=x', 'ask'],
    ['reading the repo', 'gh api repos/o/r', 'allow'],
    ['reading the repo with an explicit GET', 'gh api -X GET repos/o/r', 'allow'],
    ['writing an issue', 'gh api repos/o/r/issues -f title=x', 'allow'],
    ['vulnerability alerts PUT', 'gh api -X PUT repos/o/r/vulnerability-alerts', 'ask'],
    ['vulnerability alerts DELETE', 'gh api --method DELETE repos/o/r/vulnerability-alerts', 'ask'],
    [
      'private vulnerability reporting PUT',
      'gh api -X PUT repos/o/r/private-vulnerability-reporting',
      'ask',
    ],
    ['automated security fixes PUT', 'gh api -X PUT repos/o/r/automated-security-fixes', 'ask'],
    ['reading vulnerability alerts', 'gh api repos/o/r/vulnerability-alerts', 'allow'],
    ['amend', "git commit --amend -m 'x'", 'ask'],
    ['force push', 'git push --force origin feat/x', 'ask'],
    ['force push short flag', 'git push -f', 'ask'],
    ['push to main', 'git push origin main', 'ask'],
    ['push HEAD to main', 'git push origin HEAD:main', 'ask'],
    ['push a branch', 'git push -u origin feat/x', 'allow'],
    ['hard reset', 'git reset --hard HEAD~1', 'ask'],
    ['keep reset', 'git reset --keep HEAD~1', 'ask'],
    ['merge reset', 'git reset --merge', 'ask'],
    ['mixed reset of own commit', 'git reset --mixed HEAD~1', 'allow'],
    ['clean', 'git clean -fd', 'ask'],
    ['checkout discard', 'git checkout -- .', 'ask'],
    ['branch delete', 'git branch -D old', 'ask'],
    ['rebase', 'git rebase main', 'ask'],
    ['stash', 'git stash', 'ask'],
    ['stash pop', 'git stash pop', 'ask'],
    ['stash drop', 'git stash drop', 'ask'],
    ['stash list', 'git stash list', 'allow'],
    // Comments, escapes and heredocs must not hide the commands after them.
    ['apostrophe in a comment', "# stage what's changed\ngit add -A", 'deny'],
    [
      'apostrophe before no-verify',
      "# don't bother\ngit commit --no-verify -m 'x' -- a.ts",
      'deny',
    ],
    ['escaped apostrophe', "echo it\\'s fine; git push --force origin feat/x", 'ask'],
    ['a commented-out command is not run', 'echo ok # git add -A', 'allow'],
    ['apostrophe in a heredoc body', "cat <<EOF\ndon't\nEOF\ngit add -A", 'deny'],
    [
      'a heredoc commit message is not judged as commands',
      'git add a.ts && git commit -m "$(cat <<\'EOF\'\nFix it\ngit add -A\nEOF\n)"',
      'allow',
    ],
    ['substitution inside double quotes', 'echo "$(git push --force)"', 'ask'],
    // Env assignments with quoted values that contain spaces.
    [
      'LEFTHOOK_EXCLUDE with a quoted value',
      'LEFTHOOK_EXCLUDE="gitleaks prettier" git commit -m x -- a.ts',
      'deny',
    ],
    [
      'LEFTHOOK_CONFIG with a quoted path',
      "LEFTHOOK_CONFIG='/tmp/my cfg' git commit -m x -- a.ts",
      'deny',
    ],
    [
      'GIT_CONFIG_VALUE_0 with a quoted value',
      'GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0="/tmp/x y" git commit -m x -- a.ts',
      'deny',
    ],
    ['GIT_CONFIG_NOSYSTEM stays harmless', 'GIT_CONFIG_NOSYSTEM="1" git status', 'allow'],
    // Push forms that rewrite or delete remote refs.
    ['push +main', 'git push origin +main', 'ask'],
    ['push +branch', 'git push origin +feat/x', 'ask'],
    ['push -d', 'git push -d origin feat/x', 'ask'],
    ['push :branch', 'git push origin :feat/x', 'ask'],
    ['push -uf cluster', 'git push -uf origin feat/x', 'ask'],
    ['push --all', 'git push --all origin', 'ask'],
    ['push --mirror', 'git push --mirror', 'ask'],
    ['push --mirr prefix', 'git push --mirr', 'ask'],
    ['push --forc prefix', 'git push --forc origin feat/x', 'ask'],
    // The git program behind subshells, wrappers, absolute paths and shells.
    ['subshell', '(git commit --no-verify -m x -- a.ts)', 'deny'],
    ['command substitution', 'echo $(git push --force)', 'ask'],
    ['backtick substitution', 'echo `git push --force`', 'ask'],
    ['if/then', 'if true; then git push --force; fi', 'ask'],
    ['single ampersand', 'true & git push --force origin x', 'ask'],
    ['absolute git path', '/usr/bin/git add -A', 'deny'],
    ['command wrapper', 'command git add -A', 'deny'],
    ['time wrapper', 'time git push --force', 'ask'],
    ['nice wrapper with a value', 'nice -n 5 git add -A', 'deny'],
    ['negation', '! git push --force', 'ask'],
    ['brace group', '{ git push --force; }', 'ask'],
    ['nohup in the background', 'nohup git push --force &', 'ask'],
    ['bash -ce cluster', "bash -ce 'git add -A'", 'deny'],
    ['absolute bash -c', "/bin/bash -c 'git add -A'", 'deny'],
    ['pipe into bash', "echo 'git add -A' | bash", 'ask'],
    ['redirect ampersand is not a separator', 'pnpm vitest run 2>&1 | tail -20', 'warn'],
    // More spellings of bulk adds and destructive commands.
    ['add -Av cluster', 'git add -Av', 'deny'],
    ['add -vA cluster', 'git add -vA', 'deny'],
    ['add --al prefix', 'git add --al', 'deny'],
    ['add --no-ignore-removal', 'git add --no-ignore-removal', 'deny'],
    ['clean --force -d', 'git clean --force -d', 'ask'],
    ['clean -Xf', 'git clean -Xf', 'ask'],
    ['tag --delete', 'git tag --delete v1', 'ask'],
    ['--git-dir with a separate value', 'git --git-dir .git reset --hard', 'ask'],
    ['--work-tree with a separate value', 'git --work-tree . reset --hard', 'ask'],
    ['--namespace with a separate value', 'git --namespace n push --force', 'ask'],
    [
      'backtick in a clustered double-quoted message',
      'git add a.ts && git commit -qm "Use `pnpm`"',
      'deny',
    ],
    ['reset --ha prefix', 'git reset --ha HEAD~1', 'ask'],
    ['amend prefix', "git commit --ame -m 'x'", 'ask'],
    ['commit --include with paths', "git commit --include -m 'x' -- a.ts", 'deny'],
    // A heredoc or here-string fed to a shell is a script: it is judged as commands.
    ['heredoc into bash, quoted', "bash <<'EOF'\ngit push --force\nEOF", 'ask'],
    ['heredoc into bash, bare', 'bash <<EOF\ngit add -A\nEOF', 'deny'],
    ['heredoc into sh -s', 'sh -s <<EOF\ngit add -A\nEOF', 'deny'],
    ['here-string into bash', "bash <<< 'git add -A'", 'deny'],
    ['here-string glued to its word', 'zsh <<<"git push --force"', 'ask'],
    ['a heredoc fed to cat is only text', 'cat <<EOF\ngit add -A\nEOF', 'allow'],
    // Substitutions inside double quotes are matched with a real parse, not by counting parens.
    ['quoted paren inside a substitution', 'echo "$(echo \'(\')"; git add -A', 'deny'],
    ['quoted close paren inside a substitution', 'echo "$(echo ")")"; git add -A', 'deny'],
    ['nested substitutions', 'echo "$(echo "$(echo x)")"; git add -A', 'deny'],
    ['escaped backticks in a substitution', 'echo "`echo \\`x\\``"; git add -A', 'deny'],
    [
      'heredoc commit message with an unbalanced paren',
      'git add a.ts && git commit -m "$(cat <<\'EOF\'\nFix (part 1\nEOF\n)" -- a.ts\ngit push --force',
      'ask',
    ],
    ['an unterminated substitution is judged as commands', 'echo "$(echo x; git add -A', 'deny'],
    // Heredoc delimiters are read as full shell words and must match a line exactly.
    ['delimiter with a dot', 'cat <<END.txt\nx\nEND.txt\ngit add -A', 'deny'],
    ['delimiter built from quoted parts', 'cat <<E"O"F\nx\nEOF\ngit add -A', 'deny'],
    ['shift inside $(( ))', 'echo $((a<<b))\ngit add -A', 'deny'],
    ['shift inside (( ))', '(( x << y ))\ngit add -A', 'deny'],
    ['a delimiter that never appears skips nothing', 'cat <<EOF\nnothing\ngit add -A', 'deny'],
    ['<<- strips leading tabs', 'cat <<-EOF\n\tbody\n\tEOF\ngit add -A', 'deny'],
    [
      'a plain heredoc is not ended by an indented delimiter',
      'cat <<EOF\nx\n\tEOF\ngit add -A\nEOF',
      'allow',
    ],
    // Wrappers that run another program.
    ['timeout', 'timeout 60 git push --force', 'ask'],
    ['timeout with a signal option', 'timeout -s KILL 60 git add -A', 'deny'],
    ['sudo', 'sudo git push --force', 'ask'],
    ['sudo -u', 'sudo -u bob git push --force', 'ask'],
    // A long option's value is the next word, and any unambiguous prefix of the name counts.
    ['sudo --user VALUE', 'sudo --user root git push --force', 'ask'],
    ['sudo --use VALUE, a prefix', 'sudo --use root git add -A', 'deny'],
    ['sudo --group VALUE', 'sudo --group wheel git add -A', 'deny'],
    ['sudo --host VALUE', 'sudo --host box git add -A', 'deny'],
    ['sudo --prompt VALUE', 'sudo --prompt pw git add -A', 'deny'],
    ['sudo --role VALUE', 'sudo --role r git add -A', 'deny'],
    ['sudo --type VALUE', 'sudo --type t git add -A', 'deny'],
    ['sudo --other-user VALUE', 'sudo --other-user bob git add -A', 'deny'],
    ['sudo --close-from VALUE', 'sudo --close-from 5 git add -A', 'deny'],
    ['sudo --command-timeout VALUE', 'sudo --command-timeout 5 git add -A', 'deny'],
    ['sudo --user=VALUE', 'sudo --user=root git add -A', 'deny'],
    ['timeout --signal VALUE', 'timeout --signal KILL 5 git push --force', 'ask'],
    ['timeout --kill-after VALUE', 'timeout --kill-after 5 10 git add -A', 'deny'],
    ['nice --adjustment VALUE', 'nice --adjustment 5 git add -A', 'deny'],
    ['stdbuf --input VALUE', 'stdbuf --input L git add -A', 'deny'],
    ['stdbuf --output VALUE', 'stdbuf --output L git add -A', 'deny'],
    ['stdbuf --error VALUE', 'stdbuf --error L git add -A', 'deny'],
    ['xargs --max-args VALUE', 'echo x | xargs --max-args 1 git add -A', 'deny'],
    ['xargs --replace VALUE', 'echo x | xargs --replace {} git add -A', 'deny'],
    ['xargs --max-lines VALUE', 'echo x | xargs --max-lines 1 git add -A', 'deny'],
    ['xargs --max-procs VALUE', 'echo x | xargs --max-procs 2 git add -A', 'deny'],
    ['xargs --delimiter VALUE', 'echo x | xargs --delimiter , git add -A', 'deny'],
    ['xargs --max-chars VALUE', 'echo x | xargs --max-chars 99 git add -A', 'deny'],
    ['xargs --eof VALUE', 'echo x | xargs --eof END git add -A', 'deny'],
    ['xargs --arg-file VALUE', 'echo x | xargs --arg-file f git add -A', 'deny'],
    ['xargs', 'echo a.ts | xargs git add -A', 'deny'],
    ['xargs with options', 'echo x | xargs -n 1 git push --force', 'ask'],
    ['env -S', "env -S 'git add -A'", 'deny'],
    ['exec -a', 'exec -a name git add -A', 'deny'],
    ['nice --adjustment', 'nice --adjustment=5 git add -A', 'deny'],
    ['stdbuf', 'stdbuf -oL git push --force', 'ask'],
    ['setsid', 'setsid git push --force', 'ask'],
    ['wrappers by absolute path', '/usr/bin/sudo /usr/bin/env git add -A', 'deny'],
    // ANSI-C quoting lets \' sit inside the quotes.
    ['ANSI-C quote with an escaped apostrophe', "echo $'it\\'s'; git add -A", 'deny'],
    ['ANSI-C quote hides only its own text', "echo $'git add -A; x'", 'allow'],
    ['add a directory', 'git add src', 'warn'],
    ['test output piped to tail', 'pnpm vitest run | tail -20', 'warn'],
    ['exit code echo after tests', 'make gate; echo $?', 'warn'],
  ])('%s', (_name, command, expected) => {
    const { outcome, exit } = runHook(bash(command, clean));
    expect(outcome).toBe(expected);
    expect(exit).toBe(0);
  });
});

describe("git guard with another session's work already staged", () => {
  it.each<[string, string, Outcome]>([
    ['add then commit would sweep in the staged file', "git add a.ts && git commit -m 'x'", 'deny'],
    ['re-adding the staged file is a retry', "git add other.ts && git commit -m 'x'", 'allow'],
    ['a directory add does not cover it', "git add src && git commit -m 'x'", 'deny'],
    ['a pathspec commit takes only its paths', "git commit -m 'x' -- a.ts", 'allow'],
    [
      '--include sweeps in the index despite the pathspec',
      "git add a.ts && git commit -i -m 'x' -- a.ts",
      'deny',
    ],
  ])('%s', (_name, command, expected) => {
    expect(runHook(bash(command, dirty)).outcome).toBe(expected);
  });

  it('names the staged path in the deny reason', () => {
    expect(runHook(bash("git add a.ts && git commit -m 'x'", dirty)).reason).toContain('other.ts');
  });
});

// A checkout laid out as AGENTS.md says: the main checkout `10db/`, an agent's linked worktree in
// `10db-worktrees/` beside it, and a linked worktree anywhere else. Inside the agent's worktree,
// discarding named files is that agent's own business; everywhere else it still asks.
describe('git guard in an agent worktree beside the checkout', () => {
  let layout: string;
  let checkout: ThrowawayRepo;
  let agent: string;
  let elsewhere: string;
  let replaced: string;
  let fakeOfCheckout: string;
  let fakeOfAgent: string;

  beforeAll(() => {
    layout = mkdtempSync(join(tmpdir(), '10db-guard-layout-'));
    checkout = createThrowawayRepo('10db-guard', join(layout, '10db'));
    for (const file of ['a.ts', 'b.ts', 'src/c.ts']) checkout.stage(file, 'x\n');
    checkout.commit('seed');
    agent = join(layout, '10db-worktrees', 'agent');
    elsewhere = join(layout, 'elsewhere', 'agent');
    checkout.git('worktree', 'add', '-q', '-b', 'feat/agent', agent);
    checkout.git('worktree', 'add', '-q', '-b', 'feat/elsewhere', elsewhere);
    // A tracked file deleted from disk is still one index entry.
    rmSync(join(agent, 'b.ts'));
    // A worktree whose tracked directory src/ was replaced on disk by a file named src.
    replaced = join(layout, '10db-worktrees', 'replaced');
    checkout.git('worktree', 'add', '-q', '-b', 'feat/replaced', replaced);
    rmSync(join(replaced, 'src'), { recursive: true });
    writeFileSync(join(replaced, 'src'), 'X\n');
    // Directories in 10db-worktrees/ that are not linked worktrees: a `.git` file pointing at the
    // main checkout's repository, and one pointing at another worktree's git directory.
    fakeOfCheckout = join(layout, '10db-worktrees', 'fake-checkout');
    fakeOfAgent = join(layout, '10db-worktrees', 'fake-agent');
    for (const [dir, gitdir] of [
      [fakeOfCheckout, join(checkout.dir, '.git')],
      [fakeOfAgent, join(checkout.dir, '.git', 'worktrees', 'agent')],
    ] as const) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, '.git'), `gitdir: ${gitdir}\n`);
      writeFileSync(join(dir, 'a.ts'), 'x\n');
    }
  });

  afterAll(() => {
    rmSync(layout, { recursive: true, force: true });
  });

  // CHECKOUT in a command stands for the main checkout's path.
  const inAgent = (command: string, cwd = agent): Outcome =>
    runHook(bash(command.replaceAll('CHECKOUT', checkout.dir), cwd)).outcome;

  it.each<[string, string, Outcome]>([
    ['checkout -- one file', 'git checkout -- a.ts', 'allow'],
    ['checkout -- two files', 'git checkout -- a.ts src/c.ts', 'allow'],
    ['checkout a commit -- a file', 'git checkout HEAD -- a.ts', 'allow'],
    ['checkout -q -- a file', 'git checkout -q -- a.ts', 'allow'],
    ['restore one file', 'git restore a.ts', 'allow'],
    ['restore -- a file', 'git restore -- a.ts', 'allow'],
    ['restore --worktree --staged', 'git restore --worktree --staged a.ts', 'allow'],
    ['restore -SW', 'git restore -SW a.ts', 'allow'],
    ['restore --source=', 'git restore --source=HEAD a.ts', 'allow'],
    ['restore -s with a value', 'git restore -s HEAD -- a.ts', 'allow'],
    ['restore a tracked file deleted from disk', 'git restore b.ts', 'allow'],
    ['restore an untracked path', 'git restore gone.ts', 'ask'],
    // refs/stash is shared by every worktree of the repository.
    ['stash store', "git stash store -m 'keep' 0123abc", 'ask'],
    ['stash list', 'git stash list', 'allow'],
    // Whole-tree, directory and pattern forms still ask.
    ['checkout -- .', 'git checkout -- .', 'ask'],
    ['checkout -- a directory', 'git checkout -- src', 'ask'],
    ['checkout -- a glob', "git checkout -- '*.ts'", 'ask'],
    ['checkout -- pathspec magic', "git checkout -- ':/a.ts'", 'ask'],
    ['checkout -- a parent path', 'git checkout -- ../a.ts', 'ask'],
    ['checkout -- with nothing named', 'git checkout --', 'ask'],
    ['checkout -f -- a file', 'git checkout -f -- a.ts', 'ask'],
    ['checkout --pathspec-from-file', 'git checkout --pathspec-from-file=list -- a.ts', 'ask'],
    ['restore .', 'git restore .', 'ask'],
    ['restore a directory', 'git restore src', 'ask'],
    ['restore a glob', "git restore '*.ts'", 'ask'],
    ['restore with no path', 'git restore', 'ask'],
    ['restore --patch', 'git restore -p a.ts', 'ask'],
    ['restore --pathspec-from-file', 'git restore --pathspec-from-file=list', 'ask'],
    ['stash', 'git stash', 'ask'],
    ['stash push of a file', 'git stash push a.ts', 'ask'],
    ['stash pop', 'git stash pop', 'ask'],
    ['stash drop', 'git stash drop', 'ask'],
    // A command that reaches another checkout gets no exception.
    ['cd to the checkout first', 'cd CHECKOUT && git checkout -- a.ts', 'ask'],
    ['pushd to the checkout first', 'pushd CHECKOUT; git restore a.ts', 'ask'],
    ['git -C the checkout', 'git -C CHECKOUT restore a.ts', 'ask'],
    ['git --work-tree', 'git --work-tree=CHECKOUT restore a.ts', 'ask'],
    ['GIT_DIR prefix', 'GIT_DIR=CHECKOUT/.git git restore a.ts', 'ask'],
    ['GIT_WORK_TREE exported', 'export GIT_WORK_TREE=CHECKOUT; git restore a.ts', 'ask'],
    ['env -C', 'env -C CHECKOUT git restore a.ts', 'ask'],
    ['cd inside bash -c', "bash -c 'cd CHECKOUT && git restore a.ts'", 'ask'],
    ['cd, then bash -c', "cd CHECKOUT && bash -c 'git restore a.ts'", 'ask'],
    ['cd inside eval', "eval 'cd CHECKOUT'; git restore a.ts", 'ask'],
    // Only a lone, plain git command gets the exception: anything the shell expands or runs first
    // could point git somewhere else.
    [
      'a directory change spelled through variables',
      'X=c; Y=d; $X$Y CHECKOUT; git restore a.ts',
      'ask',
    ],
    ['a quoted cd', '"c"d CHECKOUT && git restore a.ts', 'ask'],
    ['source first', 'source ./there.sh; git restore a.ts', 'ask'],
    ['dot first', '. ./there.sh && git restore a.ts', 'ask'],
    ['a leading env assignment', 'FOO=1 git restore a.ts', 'ask'],
    ['a wrapper', 'command git restore a.ts', 'ask'],
    ['another command first', 'true && git restore a.ts', 'ask'],
    ['a substitution anywhere', 'git restore a.ts "$(true)"', 'ask'],
    // Any git option before the verb, config above all, can point git elsewhere.
    ['-c core.worktree', 'git -c core.worktree=CHECKOUT checkout -- a.ts', 'ask'],
    ['-c include.path', 'git -c include.path=/tmp/x.cfg restore a.ts', 'ask'],
    ['--config-env', 'git --config-env=core.worktree=HOME restore a.ts', 'ask'],
    ['--namespace', 'git --namespace n restore a.ts', 'ask'],
    ['--exec-path', 'git --exec-path=/tmp restore a.ts', 'ask'],
    ['--no-pager', 'git --no-pager restore a.ts', 'ask'],
    // Pathspecs the shell would expand don't count as named files.
    ['a variable pathspec', 'git restore $F', 'ask'],
    ['a braced variable pathspec', 'git checkout -- ${F}', 'ask'],
    ['a backtick pathspec', 'git restore `echo a.ts`', 'ask'],
    ['a tilde pathspec', 'git restore ~/a.ts', 'ask'],
    ['a brace-expansion pathspec', 'git restore {a,b}.ts', 'ask'],
    ['a quoted brace pathspec', "git checkout -- 'x{1}.ts'", 'ask'],
    // Every other rule holds in an agent worktree.
    ['hard reset', 'git reset --hard HEAD', 'ask'],
    ['clean', 'git clean -fd', 'ask'],
    ['branch delete', 'git branch -D feat/x', 'ask'],
    ['amend', "git commit --amend -m 'x'", 'ask'],
    ['rebase', 'git rebase main', 'ask'],
    ['force push', 'git push --force origin feat/agent', 'ask'],
    ['push to main', 'git push origin HEAD:main', 'ask'],
    ['commit --no-verify', "git add a.ts && git commit --no-verify -m 'x'", 'deny'],
    ['add -A', 'git add -A', 'deny'],
    ['discard alongside a force push', 'git restore a.ts && git push --force', 'ask'],
  ])('%s', (_name, command, expected) => {
    expect(inAgent(command)).toBe(expected);
  });

  it('asks about a path that names a tracked directory replaced by a file on disk', () => {
    expect(inAgent('git checkout -- src', replaced)).toBe('ask');
    expect(inAgent('git restore src', replaced)).toBe('ask');
  });

  it.each<[string, string]>([
    ['checkout of a commit', 'git checkout HEAD -- a.ts'],
    ['restore', 'git restore a.ts'],
  ])(
    '%s asks in a directory whose .git file points at another repository or worktree',
    (_name, command) => {
      expect(inAgent(command, fakeOfCheckout)).toBe('ask');
      expect(inAgent(command, fakeOfAgent)).toBe('ask');
    },
  );

  it('applies from a subdirectory of the agent worktree', () => {
    expect(inAgent('git restore c.ts', join(agent, 'src'))).toBe('allow');
  });

  it.each<[string, string]>([
    ['checkout -- one file', 'git checkout -- a.ts'],
    ['restore one file', 'git restore a.ts'],
  ])('%s still asks in the main checkout and in a worktree elsewhere', (_name, command) => {
    expect(inAgent(command, checkout.dir)).toBe('ask');
    expect(inAgent(command, elsewhere)).toBe('ask');
  });
});

// A bare `git push` pushes the branch checked out in the directory the command runs in, which a
// `cd` earlier in the same command line can change. The guard follows a `cd` it can read and
// keeps asking when it can't tell.
describe('git guard judging a push in the directory the command runs in', () => {
  let layout: string;
  let checkout: ThrowawayRepo;
  let worktree: string;
  let onMainSub: string;

  beforeAll(() => {
    layout = mkdtempSync(join(tmpdir(), '10db-guard-cd-'));
    checkout = createThrowawayRepo('10db-guard', join(layout, '10db'));
    checkout.stage('a.ts', 'x\n');
    checkout.commit('seed');
    checkout.git('branch', '-m', 'main');
    worktree = join(layout, '10db-worktrees', 'pr147');
    checkout.git('worktree', 'add', '-q', '-b', 'feat/pr147', worktree);
    onMainSub = join(checkout.dir, 'sub');
    mkdirSync(onMainSub);
  });

  afterAll(() => {
    rmSync(layout, { recursive: true, force: true });
  });

  // WT, MAIN and SUB stand for the feature worktree, the main checkout and a directory in it.
  const run = (command: string, cwd: string): Outcome =>
    runHook(
      bash(
        command
          .replaceAll('WT', worktree)
          .replaceAll('MAIN', checkout.dir)
          .replaceAll('SUB', onMainSub),
        cwd,
      ),
    ).outcome;

  it.each<[string, string, Outcome]>([
    ['cd to the worktree, then push', 'cd WT && git push', 'allow'],
    ['commit then push after the cd', "cd WT && git commit -m 'x' -- a.ts && git push", 'allow'],
    ['cd ; push', 'cd WT; git push', 'allow'],
    ['cd on its own line', 'cd WT\ngit push', 'allow'],
    ['cd -- path', 'cd -- WT && git push', 'allow'],
    ['cd -L path', 'cd -L WT && git push', 'allow'],
    ['quoted path', "cd 'WT' && git push", 'allow'],
    ['relative cd', 'cd ../10db-worktrees/pr147 && git push', 'allow'],
    ['push with a remote and no refspec', 'cd WT && git push origin', 'allow'],
    ['git -C the worktree', 'git -C WT push', 'allow'],
    ['cd, then git -C a relative path', 'cd WT/.. && git -C pr147 push', 'allow'],
    ['cd then bash -c', "cd WT && bash -c 'git push'", 'allow'],
    ['cd chain', 'cd MAIN && cd WT && git push', 'allow'],
    ['cd after another command', 'git status && cd WT && git push', 'allow'],
    ['cd into a checkout on main, then cd away', 'cd MAIN; cd WT; git push', 'allow'],
    ['push inside a bash -c with its own cd', "bash -c 'cd WT && git push'", 'allow'],
    [
      'pull request with a message that says cd',
      "cd WT && git commit -m 'cd MAIN' -- a.ts",
      'allow',
    ],
    ['cd, then push in a subshell', 'cd WT && (git push)', 'allow'],
    ['cd and push in one subshell', '(cd WT && git push)', 'allow'],
    // The `)` of a command substitution is not a subshell's: it keeps the directory the cd set.
    [
      'cd, then a command substitution, then push',
      "cd WT && git add $(git diff --name-only) && git commit -m 'x' -- a.ts && git push",
      'allow',
    ],
    ['cd, then an arithmetic expansion, then push', 'cd WT && n=$((1 + 2)) && git push', 'allow'],
    [
      'cd, then a nested substitution, then push',
      'cd WT && echo $(echo $(pwd)) && git push',
      'allow',
    ],
    // The rest of the push rules hold after a cd.
    ['force push', 'cd WT && git push --force origin feat/pr147', 'ask'],
    ['push to main', 'cd WT && git push origin HEAD:main', 'ask'],
    ['push --no-verify', 'cd WT && git push --no-verify', 'deny'],
  ])('%s', (_name, command, expected) => {
    expect(run(command, checkout.dir)).toBe(expected);
  });

  // A cd to a checkout on main, or a cd the guard can't read, asks whichever directory the
  // session is in: from the feature worktree too, where a bare push would be allowed.
  it.each<[string, string]>([
    ['cd to the main checkout', 'cd MAIN && git push'],
    ['cd to a subdirectory of the main checkout', 'cd SUB && git push'],
    ['git -C the main checkout', 'git -C MAIN push'],
    ['cd to a variable', 'cd $DIR && git push'],
    ['cd to a braced variable', 'cd ${DIR} && git push'],
    ['cd to a substitution', 'cd $(pwd) && git push'],
    ['cd to a backtick substitution', 'cd `pwd` && git push'],
    ['cd to a tilde path', 'cd ~/work && git push'],
    ['cd to a glob', 'cd WT* && git push'],
    ['cd to a directory that is not there', 'cd /no/such/dir && git push'],
    ['cd to a file', 'cd WT/.git && git push'],
    ['cd with no operand', 'cd && git push'],
    ['cd -', 'cd - && git push'],
    ['cd with two operands', 'cd WT MAIN && git push'],
    ['cd to a variable, then a relative cd', 'cd $DIR && cd sub && git push'],
    ['pushd', 'pushd WT && git push'],
    ['popd', 'popd && git push'],
    ['chdir', 'chdir WT && git push'],
    ['builtin cd', 'builtin cd WT && git push'],
    ['command cd', 'command cd WT && git push'],
    ['a command word spelled through a variable', 'X=cd; $X WT && git push'],
    ['eval of a cd', "eval 'cd WT'; git push"],
    ['source a script', 'source ./go.sh && git push'],
    ['cd that may not run (||)', 'true || cd WT; git push'],
    ['cd on the left of ||', 'cd WT || true; git push'],
    ['cd in the background', 'cd WT & git push'],
    ['cd in a pipeline', 'cd WT | cat; git push'],
    ['cd in a subshell', '(cd WT); git push'],
    ['cd later in a subshell', '(true; cd WT); git push'],
    ['cd first in a subshell', '(cd WT; true); git push'],
    // A bare `((` whose close is not `))` is two nested subshells, not arithmetic.
    ['cd in nested subshells', '((cd WT; true); true); git push'],
    ['cd in nested subshells, then &&', '((cd WT; true); true) && git push'],
    ['cd, then nested subshells with a cd', 'cd MAIN && ((cd WT); true) && git push'],
    ['cd on a line of its own in a subshell', '(cd WT\ntrue)\ngit push'],
    ['cd in a subshell after a list', 'true; (cd WT && true); git push'],
    ['commit in a subshell, then push', "(cd WT && git commit -m 'x' -- a.ts) && git push"],
    ['cd first in a backtick substitution', '`cd WT; true`; git push'],
    ['cd in a backtick substitution over lines', '`cd WT\ntrue`\ngit push'],
    // bash runs a whole `&&` list ended by `&` in a background subshell.
    ['cd in a list sent to the background', 'cd WT && true & git push'],
    ['cd in a list sent to the background, then a line', 'cd WT && true &\ngit push'],
    ['cd in a command substitution', 'echo $(cd WT); git push'],
    ['a subshell cd after a substitution', 'cd WT && echo $(pwd) && (cd MAIN; true); git push'],
    ['a subshell inside a substitution', 'cd WT && echo $( (cd MAIN); pwd ) && git push'],
    ['cd in a substitution, then push', 'cd WT && echo $(cd MAIN; pwd) && git push'],
    ['cd in a group', 'if cd WT; then true; fi; git push'],
    ['cd in a loop', 'for i in 1; do cd WT; done; git push'],
    ['cd in a function', 'f() { cd WT; }; f; git push'],
    // After an earlier command, the cd may not have run by the time a later list starts.
    ['a conditional cd, then a push in the next list', 'test -d WT && cd WT; git push'],
    // Whatever else retargets git after the cd.
    ['cd, then git -C the main checkout', 'cd WT && git -C MAIN push'],
    ['cd, then git --git-dir', 'cd WT && git --git-dir=MAIN/.git push'],
    ['cd, then git --work-tree', 'cd WT && git --work-tree=MAIN push'],
    ['cd, then env -C', 'cd WT && env -C MAIN git push'],
    ['cd, then env -CDIR attached', 'cd WT && env -CMAIN git push'],
    ['cd, then env --chdir DIR', 'cd WT && env --chdir MAIN git push'],
    ['cd, then env --chdir=DIR', 'cd WT && env --chdir=MAIN git push'],
    ['cd, then sudo -DDIR attached', 'cd WT && sudo -DMAIN git push'],
    ['cd, then sudo -D DIR', 'cd WT && sudo -D MAIN git push'],
    ['cd, then sudo --chdir DIR', 'cd WT && sudo --chdir MAIN git push'],
    ['env -CDIR attached', 'env -CMAIN git push'],
    ['env --chdir DIR', 'env --chdir MAIN git push'],
    // A group of short options ending in one that takes a value, and shortened long options.
    ['cd, then env -iC DIR', 'cd WT && env -iC MAIN git push'],
    ['cd, then sudo -nD DIR', 'cd WT && sudo -nD MAIN git push'],
    ['cd, then env --ch DIR', 'cd WT && env --ch MAIN git push'],
    ['cd, then env --ch=DIR', 'cd WT && env --ch=MAIN git push'],
    ['cd, then sudo --chd DIR', 'cd WT && sudo --chd MAIN git push'],
    ['env -iC DIR', 'env -iC MAIN git push'],
    ['sudo -nD DIR', 'sudo -nD MAIN git push'],
    ['env --ch DIR', 'env --ch MAIN git push'],
    ['env --ch=DIR', 'env --ch=MAIN git push'],
    // A long option's value in the next word, so git is still found after it.
    ['cd, then sudo --user root', 'cd WT && sudo --user root git -C MAIN push'],
    ['cd, then timeout --signal KILL', 'cd WT && timeout --signal KILL 5 git -C MAIN push'],
    ['cd, then GIT_DIR', 'cd WT && GIT_DIR=MAIN/.git git push'],
    ['cd, then GIT_WORK_TREE exported', 'cd WT && export GIT_WORK_TREE=MAIN; git push'],
    ['cd, then git -C a variable', 'cd WT && git -C $D push'],
  ])('%s asks from either session directory', (_name, command) => {
    expect(run(command, checkout.dir)).toBe('ask');
    expect(run(command, worktree)).toBe('ask');
  });

  it('allows a conditional cd followed by a push in the same list', () => {
    expect(run('test -d WT && cd WT && git push', checkout.dir)).toBe('allow');
  });

  it('still judges a push without a cd by the session directory', () => {
    expect(run('git push', checkout.dir)).toBe('ask');
    expect(run('git push', worktree)).toBe('allow');
  });

  it.each([
    'sudo --user root git push',
    'timeout --signal KILL 5 git push',
    'nice --adjustment 5 git push',
  ])('finds git after a wrapper long option value in %s', (command) => {
    expect(run(command, checkout.dir)).toBe('ask');
    expect(run(command, worktree)).toBe('allow');
  });

  it('judges a cd to the main checkout from a session directory in the worktree', () => {
    expect(run('cd MAIN && git push', worktree)).toBe('ask');
    expect(run('cd .. && git push', onMainSub)).toBe('ask');
  });
});

// The repository squash-merges, so a merged branch is never an ancestor of main and only `-D`
// deletes it. A branch whose pull request merged and whose tip is that pull request's head commit
// loses nothing, so deleting it doesn't ask. A fake `gh` on PATH answers from FAKE_GH_OUT.
describe('git guard deleting a branch whose pull request merged', () => {
  let repo: ThrowawayRepo;
  let bin: string;
  let tip: string;
  let ahead: string;

  beforeAll(() => {
    repo = createThrowawayRepo('10db-guard-merged');
    repo.stage('a.ts', 'x\n');
    repo.commit('seed');
    repo.git('branch', 'merged');
    repo.git('branch', 'other-merged');
    repo.git('branch', 'open');
    repo.git('branch', 'ahead');
    tip = repo.gitOutput('rev-parse', 'merged');
    // `ahead` carries a commit its pull request never had.
    repo.git('checkout', '-q', 'ahead');
    repo.stage('b.ts', 'y\n');
    repo.commit('added after the pull request');
    ahead = repo.gitOutput('rev-parse', 'ahead');
    repo.git('checkout', '-q', 'feat/x');
    bin = mkdtempSync(join(tmpdir(), '10db-guard-gh-'));
    writeFileSync(
      join(bin, 'gh'),
      '#!/bin/sh\n[ -n "$FAKE_GH_OUT" ] || exit 1\nprintf "%s" "$FAKE_GH_OUT"\n',
      { mode: 0o755 },
    );
  });

  afterAll(() => {
    repo.remove();
    rmSync(bin, { recursive: true, force: true });
  });

  const pr = (headRefName: string, headRefOid: string, state = 'MERGED') => ({
    headRefName,
    headRefOid,
    state,
    number: 1,
  });

  const outcome = (command: string, prs?: unknown[], cwd = repo.dir): Outcome =>
    runHook(bash(command, cwd), {
      PATH: `${bin}:${process.env['PATH'] ?? ''}`,
      ...(prs === undefined ? {} : { FAKE_GH_OUT: JSON.stringify(prs) }),
    }).outcome;

  it.each<[string, string, Outcome]>([
    ['-D', 'git branch -D merged', 'allow'],
    ['--delete --force', 'git branch --delete --force merged', 'allow'],
    ['-D with a remote-tracking flag', 'git branch -r -D merged', 'ask'],
    ['-D of a branch that does not exist', 'git branch -D nope', 'ask'],
    ['-D of the checked-out branch', 'git branch -D feat/x', 'ask'],
    ['-D with no branch', 'git branch -D', 'ask'],
    ['-D of a revision, not a branch', 'git branch -D merged~1', 'ask'],
    ['-D after another command', 'true && git branch -D merged', 'ask'],
    ['-D through a wrapper', 'command git branch -D merged', 'ask'],
    ['-D with git -C', 'git -C . branch -D merged', 'ask'],
    ['-D with a substitution', 'git branch -D "$(echo merged)"', 'ask'],
  ])('%s', (_name, command, expected) => {
    expect(outcome(command, [pr('merged', tip), pr('other-merged', tip)])).toBe(expected);
  });

  it('allows deleting several branches when each one merged', () => {
    const prs = [pr('merged', tip), pr('other-merged', tip)];
    expect(outcome('git branch -D merged other-merged', prs)).toBe('allow');
  });

  it('asks when one of several branches did not merge', () => {
    expect(outcome('git branch -D merged open', [pr('merged', tip)])).toBe('ask');
  });

  it('asks for a branch with commits added after its pull request head', () => {
    expect(outcome('git branch -D ahead', [pr('ahead', tip)])).toBe('ask');
    expect(ahead).not.toBe(tip);
  });

  it('asks when the pull request is not merged', () => {
    expect(outcome('git branch -D open', [pr('open', tip, 'OPEN')])).toBe('ask');
    expect(outcome('git branch -D open', [pr('open', tip, 'CLOSED')])).toBe('ask');
  });

  it('asks when the merged pull request has a different head commit', () => {
    expect(outcome('git branch -D merged', [pr('merged', ahead)])).toBe('ask');
  });

  it('asks when the merged pull request is for another branch', () => {
    expect(outcome('git branch -D merged', [pr('somewhere-else', tip)])).toBe('ask');
  });

  it('asks when no pull request exists', () => {
    expect(outcome('git branch -D merged', [])).toBe('ask');
  });

  it('asks when gh fails or answers with something else', () => {
    expect(outcome('git branch -D merged')).toBe('ask');
    const garbage = runHook(bash('git branch -D merged', repo.dir), {
      PATH: `${bin}:${process.env['PATH'] ?? ''}`,
      FAKE_GH_OUT: 'not json',
    });
    expect(garbage.outcome).toBe('ask');
  });

  it('asks when gh is not installed', () => {
    const noGh = mkdtempSync(join(tmpdir(), '10db-guard-nogh-'));
    try {
      const result = runHook(bash('git branch -D merged', repo.dir), {
        PATH: `${noGh}:${dirname(process.execPath)}:/usr/bin:/bin`,
      });
      expect(result.outcome).toBe('ask');
    } finally {
      rmSync(noGh, { recursive: true, force: true });
    }
  });

  it('keeps the other irreversible rules when a deletion is allowed', () => {
    expect(outcome('git branch -D merged && git reset --hard', [pr('merged', tip)])).toBe('ask');
  });

  describe('asks GitHub only for a deletion that would otherwise ask', () => {
    let calls: string;
    let recorder: string;

    beforeAll(() => {
      calls = join(bin, 'calls');
      recorder = mkdtempSync(join(tmpdir(), '10db-guard-gh-rec-'));
      writeFileSync(
        join(recorder, 'gh'),
        `#!/bin/sh\necho "$@" >> '${calls}'\nprintf '%s' "$FAKE_GH_OUT"\n`,
        { mode: 0o755 },
      );
    });

    afterAll(() => {
      rmSync(recorder, { recursive: true, force: true });
    });

    const ghCalls = (command: string): string[] => {
      rmSync(calls, { force: true });
      runHook(bash(command, repo.dir), {
        PATH: `${recorder}:${process.env['PATH'] ?? ''}`,
        FAKE_GH_OUT: JSON.stringify([pr('merged', tip)]),
      });
      return existsSync(calls) ? readFileSync(calls, 'utf8').split('\n').filter(Boolean) : [];
    };

    it.each<[string, string]>([
      ['-d', 'git branch -d merged'],
      ['-df', 'git branch -df merged'],
      ['listing', 'git branch --list'],
      ['creating', 'git branch fresh merged'],
      ['-D with a remote-tracking flag', 'git branch -r -D merged'],
    ])('runs no gh for %s', (_name, command) => {
      expect(ghCalls(command)).toEqual([]);
    });

    it('still asks gh about a -D deletion', () => {
      expect(ghCalls('git branch -D merged')).toHaveLength(1);
    });
  });

  describe('caps the total time spent waiting on gh', () => {
    let slow: string;

    beforeAll(() => {
      slow = mkdtempSync(join(tmpdir(), '10db-guard-gh-slow-'));
      // Each call answers after a second, with both pull requests merged.
      writeFileSync(join(slow, 'gh'), '#!/bin/sh\nsleep 1\nprintf "%s" "$FAKE_GH_OUT"\n', {
        mode: 0o755,
      });
    });

    afterAll(() => {
      rmSync(slow, { recursive: true, force: true });
    });

    const slowOutcome = (budget: string) =>
      runHook(bash('git branch -D merged other-merged', repo.dir), {
        PATH: `${slow}:${process.env['PATH'] ?? ''}`,
        FAKE_GH_OUT: JSON.stringify([pr('merged', tip), pr('other-merged', tip)]),
        TENDB_GIT_GUARD_GH_BUDGET_MS: budget,
      }).outcome;

    it('allows when every branch is confirmed inside the budget', () => {
      expect(slowOutcome('20000')).toBe('allow');
    });

    it('counts the branches not yet confirmed as unconfirmed and asks', () => {
      // The first lookup takes 1 s and confirms; the second gets the 0.5 s left, is cut off and asks.
      expect(slowOutcome('1500')).toBe('ask');
    });
  });
});

describe('git guard fails open', () => {
  const outsideRepo = JSON.stringify({
    tool_name: 'Bash',
    cwd: tmpdir(),
    tool_input: { command: "git add a.ts && git commit -m 'x'" },
  });

  it.each<[string, string]>([
    ['non-JSON stdin', 'not json'],
    ['empty stdin', ''],
    ['non-Bash tool', JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: 'a' } })],
    ['missing command', JSON.stringify({ tool_name: 'Bash', tool_input: {} })],
    ['cwd outside any git repo', outsideRepo],
  ])('%s is allowed silently', (_name, stdin) => {
    expect(runHook(stdin)).toEqual({ outcome: 'allow', reason: '', exit: 0 });
  });

  it('allows everything when the kill switch env var is set', () => {
    expect(runHook(bash('git add -A', clean), { TENDB_GIT_GUARD: 'off' }).outcome).toBe('allow');
  });

  it('explains the fix in a deny reason', () => {
    expect(runHook(bash('git add .', clean)).reason).toContain('git add <path>');
  });
});

describe('git guard when git state is unavailable', () => {
  // cwd is outside any repo, so the staged-path lookup fails. Only the rule that needs it is
  // skipped; every other rule still applies.
  it.each<[string, string, Outcome]>([
    ['force push after an add', 'git add a.ts; git push --force origin x', 'ask'],
    ['no-verify after an add', "git add a.ts && git commit --no-verify -m 'x'", 'deny'],
    ['bulk add', 'git add -A', 'deny'],
    ['plain add then commit', "git add a.ts && git commit -m 'x'", 'allow'],
  ])('%s', (_name, command, expected) => {
    expect(runHook(bash(command, tmpdir())).outcome).toBe(expected);
  });
});
