# Security policy

## Reporting a vulnerability

Report vulnerabilities privately through GitHub:
[open a private security advisory](https://github.com/travistruett/10db/security/advisories/new).
Don't open a public issue, pull request or discussion for a security problem.

Include what you found, how to reproduce it and what an attacker could do with it. You get an
acknowledgement within a week. Fixes ship in a new release, and the advisory is published once
users can update.

## Supported versions

Only the latest release gets security fixes.

## Scope

10db runs locally on macOS. Its daemon listens on `127.0.0.1` only. Reports about the daemon's
loopback API, the managed Claude Code sessions, the desktop app and this repository's build and
release pipeline are all in scope.
