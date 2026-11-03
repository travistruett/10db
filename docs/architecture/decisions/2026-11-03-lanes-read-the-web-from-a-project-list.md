# Lanes search the web and read a project's list of hosts with no card

- **Date:** 2026-11-03

## Decision

A sandboxed lane's `WebSearch` runs with no card unless its project turned that off, and a `WebFetch` of a host
on the project's **read list** runs with no card. Any other host raises one card that offers to add it. This is
per project: what a lane may send depends on whose code it holds. Sessions without the sandbox keep a card per call.

- **The broker decides, in every mode.** The PreToolUse hook keeps answering `ask` for both tools, so each call
  reaches `canUseTool` in `auto` and `default` mode alike and no classifier or allow rule settles it first. The
  broker reads the switch and the list at each call, so a change needs no new session. A call the classifier
  escalated still gets a card.
- **The switch.** Settings › Web access, on by default, stored per project. Off, each search raises a card that can
  only be allowed once. A stored project-wide `WebSearch` rule answers neither state: the switch is the only standing
  grant. A value that isn't a boolean reads as off.
- **The read list is its own rules.** An entry is a project-wide rule under `WebFetchHost`, a name Claude Code has no
  tool for. The reuse of `storableRule('WebFetch', …)` would have stored a rule with no pattern, which opens every
  host on one answer, so `WebFetch` rules no longer count in a sandboxed lane, including any stored earlier. The
  list is apart from Settings › Network hosts: those hosts govern the sandbox's proxy, which WebFetch never meets.
- **What counts as a host.** The host of the parsed URL, compared whole: no subdomain and no wildcard, so
  `github.com` does not cover `gist.github.com`, and `https://github.com.example.net/` and
  `https://github.com@example.net/` are not github.com. The URL must be https on port 443 with no login, at most
  2,000 characters, with no space or backslash, and name a public host, not an address or a name on the builder's own
  network (the rule of `decisions/2026-11-03-plan-researches-the-web-through-a-researcher.md`). A URL that fails can
  only be allowed once, and no answer lists anything. A search query over 300 characters gets the same card.
- **One card per host.** Calls to one host share a card whichever pages they name, across lanes and within a session.
  The card shows the first call's URL and prompt. A project-wide answer adds the host; a call that was waiting then
  runs. A denial covers the waiting calls too. An allow-once covers the call the builder read, so a waiting call in
  the same session asks again with its own URL.
- **The start of a list.** `github.com`, then hosts picked by which manifests exist and which dependencies they name:
  `package.json` gives `www.npmjs.com`, `developer.mozilla.org` and, for packages in 10db's own table
  (`registries/docs-hosts.ts`), their documentation host; `Cargo.toml` gives `docs.rs`, `go.mod` gives `pkg.go.dev`,
  and `pyproject.toml` or `requirements.txt` give `pypi.org`. A dependency the table doesn't know gets no host; its
  first read raises a card. Vendor documentation not tied to a dependency is one card away too.
- **Where the start comes from, and when.** Adding a project reads its checkout. A project added before this has its
  list started from the base branch on origin, which no lane can move, the first time it is needed. If that can't be
  read the list starts with `github.com` alone. A list starts once, so a host the builder removed stays out.
  After the start a found host never reaches the list by itself: Look Again names hosts and the builder adds each by
  name, as in `decisions/2026-10-29-network-hosts-from-package-files.md`.

## What may leave, and why that is acceptable

This does **not** rest on `decisions/2026-10-29-sandbox-is-the-boundary.md`: both tools run from Claude Code's own
process, outside the sandbox, so they are what the sandbox can't stop. It accepts a channel in the open.

What can leave with no card once this ships:

- **Text in a search query.** The lane chooses it, and it goes to the search provider. Up to 300 characters a call,
  and nothing bounds how many calls a lane makes.
- **Data in a URL to a listed host.** Up to 2,000 characters a call, in a path or query. `github.com` is one service,
  but the documentation hosts are run by third parties, who can log every URL and who see that this project uses
  their package. A listed host's owner is therefore trusted with whatever a lane puts in an address.
- **The fetch prompt.** Its text leaves this Mac with the call for Claude Code's processing of the page. This
  decision treats it as leaving, though it is not sent to the listed host as far as 10db can tell.
- **A page steering the lane into either.** A fetched page is attacker-controlled text. On `github.com` anyone can
  write an issue. A page can ask a lane to put the code it holds in a query or a URL, and nothing filters that: a
  pattern for "looks like code" would miss prose that quotes a secret and refuse prose that names a function.

What cannot leave this way is what the lane doesn't hold. A lane can't read the builder's keys, the data directory or
the login files, and its commands see no secret in their environment (`03-trust-boundaries.md`). A lane holds the
project's code, its task and what it reads from the web, so the code is what is at risk.

The Plan researcher decision refused this same shape: "giving the main session `WebFetch` behind a host list (the
code-holder could send)". A lane is the code-holder, and it now has these tools. That reasoning does not carry over,
because the split that decision protects was real for Plan and never existed for a lane:

- **Plan's session has no network and a lane already does.** A lane's commands reach every host the project allows,
  through Bash, with no card, and those are third-party registries that log URLs. A lane steered into sending code
  has that route today. This adds the search provider and the listed hosts to it; it does not open a closed door.
- **The split cost Plan little and would cost a lane the feature.** A planning conversation can ask a researcher and
  wait. A lane looks up an error text in the middle of work, and a researcher with no view of the code would need the
  error handed across anyway: the same text in the same query.
- **Cards were not stopping it.** Four cards in a few minutes for routine research is how a builder learns to press
  Allow. An approved leak behind a tired Allow is no better than one behind a list the builder can read.
- **The steered lane still has to do it in the open.** Each allowed search goes to `daemon.log`. Nothing here bounds
  what a page says, and that residual is accepted.

For a project whose code must not reach a search provider or a documentation host, this default is wrong. The
switch and an emptied list return that project to a card per call. The builder decides that per project; 10db can't
tell which projects those are.

Also accepted: a public name that resolves to a private address, as in the researcher decision, and any redirect
Claude Code follows after the broker has read the first URL, which 10db does not see.

## Why

- **The broker over the hook.** Flipping the hook's answer to allow would leave `default` mode going to the broker
  anyway and `auto` mode to the classifier, so the switch would have to live in two places, and a session's allow list
  would fix it at launch.
- **A table over each package's own `homepage`.** Dependency hosts come from files a lane can write in shared mode.
  With a table, the most a lane's edit can do is name a package, which picks a host 10db already vouches for. Reading
  `homepage` would need `node_modules`, which pnpm links (the file reader follows no link) and which no commit holds,
  and it would let any package's author name a host. The cost is the dependencies the table doesn't know.
- **Rejected:** one global list (a host fine for one project's code may not be for another's); subdomain wildcards
  (`*.github.io` is anyone's site); listing the host of every page a lane fetched once (nothing would ever be
  asked); a card for each new URL of a listed host (the four cards this removes).

## What is proven, and what is not

The broker, the rules, the list, the start, the API and the Settings section are tested (`inbox.test.ts`,
`web-hosts.test.ts`, `find-docs-hosts.test.ts`, `web-hosts-start.test.ts`, `web-access-api.test.ts`,
`web-access-section.test.tsx`). That a real session in auto mode reaches the broker and runs both tools with no card
shows only on the real SDK: `apps/daemon/test/lane-sandbox.live.test.ts` has a case for it that runs on the builder's
machine, not in a lane. Until it has passed once, treat this as built but unproven live.
