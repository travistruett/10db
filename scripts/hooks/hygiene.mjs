#!/usr/bin/env node
// Pre-commit hygiene for the staged snapshot: forbidden paths, merge conflict markers, files over
// 1 MB and paths that collide on a case-insensitive file system. It reads the index, not the
// working tree, so it judges exactly what the commit will contain. Prints every problem found.
import { execFileSync } from 'node:child_process';

const MAX_BYTES = 1024 * 1024;
const FORBIDDEN = [/^scratch\//, /^\.claude\/settings\.local\.json$/];
const CONFLICT_MARKER = /^(?:<{7} |={7}$|>{7} )/m;

/** @param {string[]} args */
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * MAX_BYTES });

/** @type {string[]} */
const problems = [];
for (const path of process.argv.slice(2)) {
  if (FORBIDDEN.some((pattern) => pattern.test(path))) {
    problems.push(`${path}: scratch/ and .claude/settings.local.json are never committed`);
    continue;
  }
  const size = Number(git('cat-file', '-s', `:${path}`).trim());
  if (size > MAX_BYTES) problems.push(`${path}: ${String(size)} bytes is over the 1 MB limit`);
  else if (CONFLICT_MARKER.test(git('show', `:${path}`)))
    problems.push(`${path}: has a merge conflict marker`);
}

/** @type {Map<string, string>} */
const byLowerCase = new Map();
for (const path of git('ls-files', '-z').split('\0').filter(Boolean)) {
  const other = byLowerCase.get(path.toLowerCase());
  if (other !== undefined)
    problems.push(`${path}: collides with ${other} on a case-insensitive file system`);
  else byLowerCase.set(path.toLowerCase(), path);
}

if (problems.length > 0) {
  console.error(`Commit refused:\n${problems.map((p) => `  ${p}`).join('\n')}`);
  process.exitCode = 1;
}
