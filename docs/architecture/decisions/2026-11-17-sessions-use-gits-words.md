# Sessions use git's words

- **Date:** 2026-11-17

## Decision

Sessions says branch, commit, pull request, merge and "your checkout". It never says "Your folder", "hold", "pass
of one" or "Separate copy" in new copy. The title row's git step is **Commit…**, then **Open Pull Request**, then
**Merge**, and on a project that merges locally **Merge into `<base>`**. A message that names who has the checkout
names the branch and the holder ("A Board task is changing files on `main`."), the branch read from the checkout,
never a hard-coded `main`. The meta line reads in the same words ("on `qa` · 3 commits not in a pull request", "1
commit not merged into `main`" on a local project).

## Why

The builder knows git; 10db's own words for the same things made them translate. Claude Code's own words are git's, and 10db has no reason tied to a hard limit to differ.
