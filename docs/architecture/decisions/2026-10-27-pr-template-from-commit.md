# The pull request template is read from the shipped commit through git

- **Date:** 2026-10-27

## Decision

Ship reads `.github/pull_request_template.md` with `Git.fileAt`, an `ls-tree` and blob read of the commit being
shipped (`delivery/pr-template.ts`), in both workspace modes. A template that is not a regular file (a link, for one) is no template, and
so is one over 64 KiB; each is logged and the body is built without it. A link directory above the path
holds no blob in the commit's tree, so it yields no template either.

## Why

The daemon is unsandboxed and the checkout is lane-writable. Reading the working file followed a symlink a
lane planted (the file or `.github`) and posted whatever it pointed at in the pull request body. The committed
content is what ships anyway, so reading it loses nothing. This also fixed shared mode, where the same read
was already exposed.
