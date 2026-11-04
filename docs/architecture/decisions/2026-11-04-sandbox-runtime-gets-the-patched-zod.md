# sandbox-runtime gets the patched zod through an override

- **Date:** 2026-11-04

## Decision

`pnpm-workspace.yaml` overrides `@anthropic-ai/sandbox-runtime>zod` to the zod the workspace pins.
Drop the override once a sandbox-runtime release depends on zod 4.

## Why

GHSA-mrhx-c7xc-m3w5 marks every zod below 4.6.6 as vulnerable. Our own packages are past it, but
sandbox-runtime 0.0.81, its latest release, depends on `zod ^3.25.0` and resolved to 3.25.76, so
`pnpm-audit` failed on main.

sandbox-runtime imports `zod/v3` and nothing else from zod. That entry exists in zod 4 too, so the
override crosses a major version of the package without changing the API the sandbox runs on. Between
3.25.76 and 4.6.7 the `v3` tree differs in three files: `__proto__` handling in `ZodError.format` and
object parsing, a stricter emoji regex, and comments. Nothing else in it changed.

- **Ignoring the advisory** was turned down. The flaw is in `$ZodArray`, which sandbox-runtime never
  loads, and it only parses the settings file the daemon writes, so it wasn't reachable. An ignore
  stays in the audit for good and hides the next finding on the same package, and the override also
  brings the `__proto__` fixes.
- **Waiting for a sandbox-runtime release** was turned down: the audit stays red until then.
