# Task 8: the Tailscale reader and the certificate probe

Read the index's brief and Global Constraints first. Size: Core (child-process output at a boundary).

**Files:** new `apps/daemon/src/sharing/tailscale-cli.ts`, new `apps/daemon/src/sharing/certificate-probe.ts`,
new `apps/daemon/src/sharing/index.ts`, new `apps/daemon/src/sharing/AGENTS.md` (copy the index's "Serve facts"
into it).

**Implements:** `CliResult`, `TailscaleRun`, `TAILSCALE_CLI_PATHS`, `findTailscaleCli`, `createTailscaleRun`,
`TailscaleSelf`, `TailscaleUnreadableError`, `readTailscaleSelf`, `CertificateProbe` and
`createCertificateProbe`, as quoted in the index.

**Rules**

- `createTailscaleRun` uses `execFile` with no shell, a 10 s timeout by default, `maxBuffer` 1 MiB, and an env of
  `PATH` and `HOME` only. `/usr/local/bin/tailscale` is a shell shim on the standalone app; that's fine.
- `TENDB_TAILSCALE=off` (set by the e2e daemon, as it sets `TENDB_SLACK: 'off'`) is parsed where `daemonOptionsFromEnv` parses the other `TENDB_*` switches, and `start.ts` then passes `cli: () => null`, so the e2e sees no Tailscale on a Mac that has one. `findTailscaleCli` itself reads no env.
- `readTailscaleSelf` runs `status --json`, parses it with a zod schema of only the fields read
  (`BackendState`, `Self.DNSName`, `Self.UserID`, `Self.Tags`, `User`, `CertDomains`, `Version`), strips the
  trailing dot from the name, and throws `TailscaleUnreadableError` (message names the missing field, never a
  value) when the output doesn't parse. A non-zero exit whose stderr says the backend isn't running is
  `running: false`, not an error.
- The probe runs `cert --cert-file - --key-file - <fqdn>` and keeps only the exit status and the last 500
  characters of stderr; stdout (the key) is discarded. `tick` runs only when due: 60 s after a success, 10 minutes
  after a failure, on the injected `Clock`. `current()` never runs the CLI.
- **The probe never makes the first certificate on its own** (the builder's call). 10db can't see whether a
  certificate exists without running `tailscale cert`, so the sharing service calls `tick` only for a name the
  builder has pressed Get Certificate for: `app_settings` key `sharing.certificateFor` holds the SHA-256 hex of that
  fqdn (never the name itself, R11). A changed name needs a new click. Say so in `sharing/AGENTS.md`.

**Tests:** none: the probe's rationing isn't a core area, and the service's test (task 9) runs through it.

**Spec:** §3.1, §3.4.
