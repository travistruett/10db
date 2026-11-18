# A copy's node_modules is cloned from a template made once per lockfile

- **Date:** 2026-11-17
- **Amends:** `decisions/2026-10-27-worktree-seed-by-clone.md`

## Decision

1. **A pnpm copy's node_modules no longer comes from Your folder.** When the copy has `pnpm-lock.yaml` and the
   seed dirs include a `node_modules`, the cut still seeds every other seed dir from the main checkout. Its
   `node_modules` dirs come from the install instead (`refresh` with `seeded: false, makeTemplate: true`):
   a clone of the template for its lockfile, or an install from nothing. A project with no `node_modules` in
   Your folder keeps the old behaviour (no install), and so does a project that isn't pnpm's.
2. **A template is built only at a cut.** The copy is new and no lane has run in it. After its sandboxed install
   (scripts and pnpmfile off, as before) passes and `checkInstall` finds it whole, the daemon clones the copy's
   `node_modules` dirs into `<dataDir>/node-modules/.staging-<uuid>/tree`, writes `template.json` (`key`,
   `dirs`) last, and renames the result to `<dataDir>/node-modules/<key>`; when that name exists the staging dir
   is removed. A gate, Retry's repair, the scratch gate and the base update's install clone a template that
   exists but never build one. `install_dependencies` (`update` mode) and a start over asked for after a broken
   install neither clone nor build one. So a changed lockfile gets its one template at the first cut that has
   it, after a base update merges it or after the branch that ran `install_dependencies` lands.
3. **What the key covers, and when a template goes.** The key is the first 32 hex characters of a sha256 over
   `pnpm@<version>`, the install summary and the bytes of `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `.npmrc`,
   `package.json` and each workspace package's `package.json` the lockfile names. With no lockfile, no known
   pnpm version, or one of those files not a regular file, there is no key and the install runs. Projects with
   identical inputs share a template. A clone that skips an entry, can't be read, or leaves `checkInstall` short
   of whole removes what it cloned and the template, and the install runs as before. Each cut removes every
   template and staging dir whose key no registered checkout or live worktree has, except those being read or
   written.

The templates sit in the data dir, which every sandbox is denied (`test/gate-sandbox.seatbelt.test.ts`), and a
copy gets a copy-on-write clone, so nothing a lane or gate writes reaches a template or another copy.

## Why

The builder's install logs: 555 of 566 end `resolved 934, reused 0, downloaded 933`, a median of 19 s and about
192 minutes in all. Each sandboxed run has its own empty store (`sandbox/command-env.ts`: no two sandboxes share
a cache), so the seed's `.modules.yaml` always named another store, `refresh` removed it, and every copy
downloaded its whole tree. The seed's clone was wasted time, and it carried the builder's own install, and
anything a shared lane wrote, into the copy.

A template made in a copy a lane has run in could hold whatever the lane wrote into `node_modules` and pass it
to every later copy, the sharing `command-env.ts` forbids; so capturing at a gate or after
`install_dependencies` was turned down. Building in a separate scratch copy would cost a second full download
for a branch lockfile that may never reach the base. The gate sandbox can't read the data dir, so an install
can't write into the template directory directly. A staging dir made with `git init`, so the gate sandbox's
`projectAccess` would accept it, was turned down as more new code for no gain.

The `.bin` shims pnpm writes hold absolute `NODE_PATH` fallbacks naming the copy the template was made in. They
are fallbacks only, and the old seed carried the same.
