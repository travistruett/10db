# Task 11: Remote Access and Devices in the app

Read the index's brief and Global Constraints first. Size: Feature inside a Core milestone (the UI only).

**Files:** `apps/desktop/src/views/settings/sections.ts`, new `remote-access-section.tsx`, new
`devices-section.tsx`, the settings view's section switch, new query hooks beside the other settings queries
(`apps/desktop/src/daemon/`), the event-to-query map in `apps/desktop/src/daemon/events.ts` (`device.changed`,
`sharing.changed`), one e2e spec under `apps/desktop/e2e/`.

**Build to the approved mock-ups** (`docs/superpowers/specs/2026-11-25-10db-remote-host-mockups.html`, frames 0–3),
with Mantine and the house components (`SectionHeading`, `SettingsCard`, `SettingRow`; never Mantine's
`Drawer`). The copy in the mock-ups and the spec's §3.1 is the copy.

- Sections: `RemoteAccess: 'remote-access'` and `Devices: 'devices'`, App scope, subhead `Connections`, after
  People. Devices' `planned` line: "Pairing a phone arrives with the phone app."
- Remote Access: under the heading in every state, the Tailscale line with its link to `https://tailscale.com`.
  With no CLI found (empty `steps`), the "Remote Access needs Tailscale" card with **Get Tailscale ↗** to
  `https://tailscale.com/download` and its three steps. Otherwise the checklist; the Certificate step, while no certificate has been asked for this name, shows the name, the public-logs sentence and **Get Certificate** (`POST /sharing/certificate`); Share and the port field; once
  Ready, the address with Copy, Stop Sharing, and the collapsed checks. The page re-reads `GET /sharing` every
  10 s while open and on `sharing.changed`. External links open through the app's existing external-link helper.
- Devices: the table (label and platform, paired, last used, Revoke with a confirm naming the device), following
  `device.changed`. No Pair button.
- The sidebar footer line "Shared on your tailnet" or "Sharing paused: <step>" where the shell's footer lives.

**Tests:** extend the e2e flow that already opens app-wide Settings (find it with `grep -l settings
apps/desktop/e2e/*.spec.ts`): open Remote Access and check the "needs Tailscale" card (the e2e daemon runs with `TENDB_TAILSCALE: 'off'` in `apps/desktop/e2e/playwright.config.ts`'s daemon env, beside `TENDB_SLACK: 'off'`), then open Devices and check its empty state. No component
tests.

**Then:** screenshots of the four states in the running app (10db Dev window, the `screens` skill) for the
builder before this task's branch merges into the integration branch, on a fresh `TENDB_DATA_DIR` (the branch's
migration is a placeholder).

**Spec:** §3.1, §5.5.
