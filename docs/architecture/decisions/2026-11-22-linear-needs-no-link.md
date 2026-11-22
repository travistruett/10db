# Linear needs no link: a project uses its account's Linear sign-in

- **Date:** 2026-11-22
- **Amends:** the Linear spec's "Sign-ins and bindings" and "Linear binding check"
  (`docs/superpowers/specs/2026-11-21-10db-linear-integration-design.md`)

## Decision

A project is not linked to a Linear team. Linear is available to a project when its account reaches Linear through
the agent's own sign-in (Claude Code's MCP servers or the claude.ai connector, Codex's servers), detected per
account; an account not yet checked counts as possibly reaching it. Writes go by Linear's own issue id, which pins the
workspace, so the workspace is the sign-in's. Import filters in words ("my ready AMP issues"): its brief names no team
or workspace. Report To Linear is on by default and the builder turns it off per project in Settings.

## Why

Linking a team was friction and bought nothing the issue id does not already give. One agent account's sign-in reaches
one workspace. 10db's rule is that the builder's setup comes along by default and the builder turns things off, not on.
A stored `linear.<projectId>` binding from before is left unread.
