# apps/daemon/src/permissions

- `permissions/network-hosts.ts` is the builder's way to allow a project's hosts ahead of a card: the same project-wide `SandboxNetworkAccess` rules, checked through `storableRule`, and refusing loopback and over-broad patterns (`decisions/2026-10-29-project-network-hosts.md`).
