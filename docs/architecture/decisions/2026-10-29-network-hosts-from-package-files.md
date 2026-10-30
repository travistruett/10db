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
nothing from the repository and starts no process: a file is opened without following a link, must be a regular file
of at most 16 MiB, and is matched with fixed patterns on the keys that hold a registry (a lockfile's `resolved`,
`tarball`, `source` and `remote` values; never a description or a link to a home page). A lockfile with no URL for its
packages names the ecosystem's default registry unless an `.npmrc` or `.yarnrc.yml` in its folder or the root names
one (npm and pnpm: `registry.npmjs.org`; yarn: `registry.yarnpkg.com`; poetry: `pypi.org` and
`files.pythonhosted.org`; cargo's crates.io: `index.crates.io` and `static.crates.io`; go: `proxy.golang.org` and
`sum.golang.org`). Each host is reported with the first file that names it, the root's files first.

**Only the host.** A URL is parsed, and the host name is all that is kept: a user name, password, token, port and path
never leave `hostOfUrl`. A value with a variable to expand names no host. The result of a reading is a list of
`{ host, file }`; no URL, no line of a file and no setting's value is returned, stored, put on a card or logged. A host
the project may not be given (`checkNetworkHost`: loopback, a bare name, a whole top-level domain) is left out, and at
most 40 hosts are taken.

**Allowing them.** Adding a project reads its folder and allows what it finds (`allowFoundHosts`) as the project-wide
`SandboxNetworkAccess` rules an Allow for the project stores, with `permission_rules.found_in` set to the file. Setup
lists the hosts before the project is added (`FolderInspection.registryHosts`). Settings › Network hosts shows each
host's source in words (`Found in Cargo.lock`, `Allowed from a card`, `Added by you`; a host's source is its oldest
rule's) and has Look Again, `POST /projects/:id/network-hosts/scan`, which reads the files again and allows what is
new. A host the builder removed comes back on Look Again, because they asked to look. The latest reading is kept in
`app_settings` (`network-hosts-found:<project id>`) so a card can say a file names a host that is not allowed now. It
is a reading of the project at the builder's last ask, not of the files a lane has since written.

**A lane's card.** The blocked-host card for a lane recommends Allow for the project when the latest reading names the
host, and its body says which file names it as a package registry. The recommendation never allows anything.

**A gate's card.** A sandboxed gate's srt host runs with `SRT_DEBUG=1` (the command does not: `env -u SRT_DEBUG`).
srt's proxy then writes `[SandboxDebug] Connection blocked to <host>:<port>` to stderr for each refused host. The gate
runner reads those lines (`verify/blocked-hosts.ts`), drops every `[SandboxDebug]` line and its continuation lines from
the log and tail (the debug log holds the command line and settings), and, for a gate that failed, reports up to ten
hosts in `GateResult.blockedHosts` and ends the tail with `10db: The gate was blocked from reaching <host>…`. The
verify gate (runner) and the shipping gate (shipper) then raise one flag card per host (`raiseGateHostCards`): the host,
the gate command, the file that names the host if any, and the options Allow for the project and Not now. Allow for the
project stores the rule in the answer's transaction, with the card as its source. A host the project may not be given or
one already allowed gets no card. Cards fold per project and host.

**Remove** in Settings › Network hosts is a default button, as DESIGN.md keeps red for failures, and a failed removal
shows its message under that host.

## Why

The builder saw Network hosts as a list they did not know how to fill, and a gate had no way to ask: cargo failed with
`CONNECT tunnel failed, response 403` and nothing said which host. The project's own files already name almost every
host it needs, and the same files that make the project buildable are the ones the builder is trusting. Reading them
needs no process, so it adds nothing to the security rule that nothing outside the sandbox acts on lane-writable input;
the limits are on what is read (no links, a size cap, keyed patterns), what is kept (hosts), and what is allowed
(`checkNetworkHost`). A hostile repository can name a host in its lockfile, and adding it allows that host: the
builder trusts the project's files when they add it, as they do when they run its gate, and Settings lists every host
with the file that named it so a surprising one can be removed.

The card for a lane reads the stored reading, not the checkout: in a shared checkout a lane can write any file, and a
card that recommended Allow because the lane had just edited a lockfile would be the lane writing its own
recommendation.

srt's proxy only reports a refused host in its debug log; the client sees `403` with no name. Reading the debug lines is
the only source in srt 0.0.81 that names the host, so the lines are consumed and dropped rather than shown. A command
can print such a line itself and so raise a card for a host it names, but the card only asks; the builder's answer is
what allows it, and the host passes the same `checkNetworkHost` first.

Turned down: allowing hosts by parsing the failure text of each tool (every tool words it differently, and most omit
the host); running the package manager to ask it for its registries (runs repository code); a table for the reading
(one JSON value per project is read only by cards).
