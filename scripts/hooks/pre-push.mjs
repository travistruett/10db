#!/usr/bin/env node
// Refuses a push that updates or deletes main on the remote: changes reach main through a PR.
// Creating main (the remote has no main yet) is allowed, so a new repository can receive its
// first push. Git writes one line per ref to stdin: <local ref> <local sha> <remote ref> <remote sha>.
import { readFileSync } from 'node:fs';

const ZERO_SHA = /^0+$/;
const refused = readFileSync(0, 'utf8')
  .split('\n')
  .map((line) => line.trim().split(' '))
  .filter(
    ([, , remoteRef, remoteSha]) =>
      remoteRef === 'refs/heads/main' && !ZERO_SHA.test(remoteSha ?? ''),
  );

if (refused.length > 0) {
  console.error(
    'Push refused: main changes only through a pull request. Push a branch and open a PR.',
  );
  process.exitCode = 1;
}
