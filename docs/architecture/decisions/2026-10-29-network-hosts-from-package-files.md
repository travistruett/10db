# A project's network hosts come from its package files, and a blocked gate asks

- **Date:** 2026-10-29
- **Amends:** `decisions/2026-10-29-project-network-hosts.md`

## Decision

**Reading the files.** `findRegistryHosts` (`apps/daemon/src/registries/`) reads the project's own package files as
text: lockfiles (`pnpm-lock.yaml`, `package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock`, `Cargo.lock`, `uv.lock`,
`poetry.lock`, `Gemfile.lock`, `go.sum`), package manager settings (`.npmrc`, `.yarnrc.yml`, `.cargo/config.toml`,
`pip.conf`, `pip.ini`, `uv.toml`, the index tables of `pyproject.toml`) and toolchain files (`rust-toolchain(.toml)`,
`.nvmrc`, `.node-version`). It looks in the project root and two levels of folders below it, skipping dot folders,
`node_modules`, `target`, `dist`, `build`, `out`, `vendor`, `venv`, `__pycache__`, `coverage` and `Pods`. It runs
nothing from the repository and starts no process: a file is read only when the real path of its folder is that
folder under the root's real path (so a link anywhere below the root, such as `.cargo` linked to `~/.cargo`, is never
followed), is opened with `O_NOFOLLOW`, must be a regular file of at most 16 MiB, and is matched with fixed patterns
on the keys that hold a registry (a lockfile's `resolved`,
`tarball`, `source` and `remote` values; never a description or a link to a home page). A TOML setting is read as a
string, an array of strings or a value in an inline table, over several lines if need be, with comments left out
(`extra-index-url = ["…"]`, `corp-mirror = { registry = "…" }`), so a mirror that replaces crates.io is found though
`Cargo.lock` still names crates.io. A lockfile with no URL for its
packages names the ecosystem's default registry unless an `.npmrc` or `.yarnrc.yml` in its folder or the root replaces
it: an unscoped `registry=`, or an unindented `npmRegistryServer`. A scoped registry (`@x:registry=`, or an
`npmRegistryServer` under `npmScopes`) serves its scope only, so it names its own host and the default stays (npm and
pnpm: `registry.npmjs.org`; yarn: `registry.yarnpkg.com`; poetry: `pypi.org` and
`files.pythonhosted.org`; cargo's crates.io: `index.crates.io` and `static.crates.io`; go: `proxy.golang.org` and
`sum.golang.org`). Each host is reported with the first file that names it, the root's files first.

**In time linear in the files.** The reading runs on the daemon's only thread, and a lane can write the files, so
every pattern takes time linear in the text it reads; the size cap bounds memory, not a pattern's time. A pattern
tried at every line start opens with `[ \t]*` or a word, never `\s*`: `\s` matches a line end too, so `^\s*` tried at
each line of a run of blank lines reads to the end of the run every time. Wherever two repeated parts of a pattern can
meet, no character matches both, so a failed match never tries another split of the same run. What a pattern can't
take apart that way is taken apart with string operations: a TOML table header is trimmed and its brackets cut off
before its name is checked, an `.npmrc` key such as `//host/path/:_authToken` is split at its last `:` and its first
`/` or `:`, and an INI value is cut off its line rather than matched. The root's `.npmrc` and `.yarnrc.yml` are read
once per reading, not again for each folder.

**Only the host.** A URL is parsed, and the host name is all that is kept: a user name, password, token, port and path
never leave `hostOfUrl`. A variable (`${NPM_TOKEN}`) or `%XX` escape (`p%40ss`, `My%20Project`) in those parts
doesn't hide the host; URL parsing decodes an escape in the host name or refuses the name. A host that still holds a
variable to expand (`https://${HOST}/`) names no host, and neither does one that holds a `*`
(URL parsing keeps it, but no package manager fetches from a wildcard, and `*.s3.amazonaws.com` would allow every
bucket): a found host is one concrete name (`checkConcreteHost`), never a pattern. The result of a reading is a list of
`{ host, file }`; no URL, no line of a file and no setting's value is returned, stored, put on a card or logged. A host
the project may not be given (`checkNetworkHost`: loopback, a bare name, a whole top-level domain) is left out, and at
most 40 hosts are taken.

**Allowing them.** Adding a project reads its folder and allows what it finds (`allowFoundHosts`) as the project-wide
`SandboxNetworkAccess` rules an Allow for the project stores, with `permission_rules.found_in` set to the file. Setup
lists the hosts before the project is added (`FolderInspection.registryHosts`). Settings › Network hosts shows each
host's source in words (`Found in Cargo.lock`, `Allowed from a card`, `Added by you`; a host's source is its oldest
rule's) and has Look Again, `POST /projects/:id/network-hosts/scan`, which reads the files again and answers the hosts
they name that no rule covers, each with its file. A rule covers a host as the sandbox's `allowedDomains` reads it
(`matchPermissionRule`, which lane and gate cards use too): its own name, or a `*.` pattern over it, so a typed
`*.crates.io` covers `index.crates.io` but not `crates.io` or an address. This amends the earlier file, where the
broker matched a running lane's host exactly: a wildcard the builder adds now covers a running lane's hosts at once too,
as a concrete host always did. It allows nothing and stores nothing: the page lists them with an
Allow beside each, and a host is allowed only when the builder presses Allow for it, after seeing its name (the same
`POST /projects/:id/network-hosts` as typing it, so its source is `Added by you`). A host the builder removed is listed
again on Look Again, not allowed again. The reading made when the project was added is kept in `app_settings`
(`network-hosts-found:<project id>`) so a card can say a file needs a host that is not allowed now. Look Again never
rewrites it: it is a reading of the project as the builder added it, not of the files a lane has since written.

**A lane's card.** The blocked-host card for a lane recommends Allow for the project when that reading names the host,
and its body says so: `The project's <file> needs <host>` (a toolchain file or `go.sum` only implies its host, so the
card calls no file a registry). The recommendation never allows anything.

**A gate's card.** A sandboxed gate's srt host runs with `SRT_DEBUG=1` (the command does not: `env -u SRT_DEBUG`).
srt's proxies then write `[SandboxDebug] Connection blocked to <host>:<port>` (a CONNECT or SOCKS request) or
`[SandboxDebug] HTTP request blocked to <host>:<port>` (plain HTTP) to stderr for each refused host. The gate runner
reads those lines (`verify/blocked-hosts.ts`) and keeps srt's debug log out of the log and tail: srt shares the
command's stderr, so the marker is looked for anywhere in a line and only the text from it on is cut (a progress meter
the command left without a newline is kept). A one-line message is all that is dropped; a message ending in `{` or `[`
(the settings srt dumps as JSON) is dropped up to its closing line; and the command line srt echoes (`Command string
mode (-c): …`, which holds the project env) is dropped for as many lines as it takes (`GateRun.commandLines`), which is
safe because srt writes it before the command starts. The filter searches only each new chunk for line ends, so a
long line costs its length once, and holds at most 2 MiB of a line with no newline: more than any message srt writes,
whose longest, the echoed command line, the 1 MiB limit on a program's arguments bounds. Past that it passes the
command's text on and keeps only what may be srt's (from its marker, or the last characters, which may begin one).
For a gate that failed, the runner reports up to ten hosts in
`GateResult.blockedHosts` and ends the tail with `10db: The gate was blocked from reaching <host>…`: a host the project
may be given is sent to the Inbox and Settings › Network hosts, and one it may not (a bare name such as `db`, this
machine, a pattern) is said to be one that can't be allowed, since no card is raised for it. The verify gate (runner) and
the shipping gate (shipper) then raise one flag card per host (`raiseGateHostCards`): the host, the gate command, the
file that needs the host if any, and the options Allow for the project and Not now. Allow for the project stores the
rule in the answer's transaction, with the card as its source. A host the project may not be given (`checkConcreteHost`:
a `*` is refused too, since a command can print the debug line itself) or one already allowed gets no card. Cards fold
per project and host.

**Remove** in Settings › Network hosts is a default button, as DESIGN.md keeps red for failures, and a failed removal
shows its message under that host.

## Why

The builder saw Network hosts as a list they did not know how to fill, and a gate had no way to ask: cargo failed with
`CONNECT tunnel failed, response 403` and nothing said which host. The project's own files already name almost every
host it needs, and the same files that make the project buildable are the ones the builder is trusting. Reading them
needs no process, so it adds nothing to the security rule that nothing outside the sandbox acts on lane-writable input;
the limits are on what is read (no links, a size cap, keyed patterns whose time is linear in the text), what is kept
(hosts), and what is allowed
(`checkNetworkHost`). A hostile repository can name a host in its lockfile, and adding it allows that host: the
builder trusts the project's files when they add it, as they do when they run its gate, and Settings lists every host
with the file that named it so a surprising one can be removed.

Only adding the project allows what the files name, because only then are the files the ones the builder chose to
trust. After that, in a shared checkout, a lane can write any file in the project: if Look Again allowed what it found,
one `@x:registry=https://exfil.example.net/` line in `.npmrc` and one click, made for some other reason such as a
blocked gate, would open that host to every lane, gate and MCP server, and the builder would learn it after the fact.
So Look Again only lists, and each host is allowed by name. For the same reason the card for a lane reads the reading
made at add time, never the checkout or a later look: a card that recommended Allow because the lane had just edited a
lockfile would be the lane writing its own recommendation.

srt's proxy only reports a refused host in its debug log; the client sees `403` with no name. Reading the debug lines is
the only source in srt 0.0.81 that names the host, so the lines are consumed and dropped rather than shown. A command
can print such a line itself and so raise a card for a host it names, but the card only asks; the builder's answer is
what allows it, and the host passes `checkConcreteHost` first, so a printed `*.example.com` raises nothing.

Turned down: allowing hosts by parsing the failure text of each tool (every tool words it differently, and most omit
the host); running the package manager to ask it for its registries (runs repository code); a table for the reading
(one JSON value per project is read only by cards).
