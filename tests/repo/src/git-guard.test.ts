import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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

  beforeAll(() => {
    layout = mkdtempSync(join(tmpdir(), '10db-guard-layout-'));
    checkout = createThrowawayRepo('10db-guard', join(layout, '10db'));
    for (const file of ['a.ts', 'b.ts', 'src/c.ts']) checkout.stage(file, 'x\n');
    checkout.commit('seed');
    agent = join(layout, '10db-worktrees', 'agent');
    elsewhere = join(layout, 'elsewhere', 'agent');
    checkout.git('worktree', 'add', '-q', '-b', 'feat/agent', agent);
    checkout.git('worktree', 'add', '-q', '-b', 'feat/elsewhere', elsewhere);
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
    ['restore a deleted file', 'git restore gone.ts', 'allow'],
    ['stash store', "git stash store -m 'keep' 0123abc", 'allow'],
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

  it('applies from a subdirectory of the agent worktree', () => {
    expect(inAgent('git restore c.ts', join(agent, 'src'))).toBe('allow');
  });

  it.each<[string, string]>([
    ['checkout -- one file', 'git checkout -- a.ts'],
    ['restore one file', 'git restore a.ts'],
    ['stash store', 'git stash store 0123abc'],
  ])('%s still asks in the main checkout and in a worktree elsewhere', (_name, command) => {
    expect(inAgent(command, checkout.dir)).toBe('ask');
    expect(inAgent(command, elsewhere)).toBe('ask');
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
