# 10db security review guidance

The security-guidance plugin's diff review reads this file. Its commit reviewer does not read it yet.

## How to report

- Report a class of vulnerability once, with every instance in the diff listed under it: file, line and the input
  that gets through. Reporting one instance per review makes a class take one fix round per instance.
- When a fix closes some instances of a class and leaves others, name the instances still open under the same
  class. Don't report them again as new findings.
- Rank by consequence against the threat model below. A bypass that stays inside the sandbox is not high severity.

## Threat model

10db is a local macOS control plane, used by one developer on their own Mac, that runs Claude Code and Codex
sessions on the developer's own projects (`docs/architecture/decisions/2026-11-12-10db-trusts-the-developer-and-contains-the-agent.md`).

- **The developer is trusted.** Input the builder types into 10db's UI, and their own config, skills, plugins and
  MCP servers, are not attacker-controlled.
- **The agent is not trusted.** Text a managed agent writes is attacker-controlled, and so is anything it reads:
  files in the checkout, tool output and web pages. That includes commands, file paths, config the agent writes
  and hook input.
- **The kernel sandbox is the boundary.** These are high severity:
  - anything that lets an agent's command run outside the sandbox;
  - anything that lets it write outside the checkout and its temp dir, or read credentials;
  - anything that lets it reach a host the project hasn't allowed;
  - anything that makes config the agent wrote run outside the sandbox without the builder's approval.
- **The four hard limits:** destroying data the agent didn't create, sending data out, reading secrets, and
  writing to anything live. A path that crosses one of them without the judge or the builder seeing it is high
  severity.
- **The daemon's local HTTP API** binds to loopback and requires its token. A request without the token is
  attacker-controlled; one with it comes from the builder's UI.
- Inside the sandbox an agent may edit, install, test and use the web freely. A finding whose only consequence is
  something the sandbox already contains is low severity at most.
