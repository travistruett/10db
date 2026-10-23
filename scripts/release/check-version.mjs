#!/usr/bin/env node
// Checks that every file carrying the app version agrees with the release version.
// Usage: node scripts/release/check-version.mjs <x.y.z>
// Exit 0: all match. Exit 1: a mismatch (each one printed). Exit 2: bad argument.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (path) => readFileSync(join(root, path), 'utf8');

const expected = process.argv[2] ?? '';
if (!/^\d+\.\d+\.\d+$/.test(expected)) {
  process.stderr.write(
    `usage: check-version.mjs <x.y.z> (got "${expected}"; strip the v from a tag)\n`,
  );
  process.exit(2);
}

function tomlString(section, key) {
  return new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, 'm').exec(section)?.[1];
}

const cargoPackage =
  read('apps/desktop/src-tauri/Cargo.toml')
    .split(/^\[/m)
    .find((section) => section.startsWith('package]')) ?? '';
const crate = tomlString(cargoPackage, 'name');
const lockEntry =
  read('apps/desktop/src-tauri/Cargo.lock')
    .split(/^\[\[package\]\]$/m)
    .find((section) => tomlString(section, 'name') === crate) ?? '';

const found = {
  'package.json': JSON.parse(read('package.json')).version,
  '.release-please-manifest.json': JSON.parse(read('.release-please-manifest.json'))['.'],
  'apps/desktop/src-tauri/tauri.conf.json': JSON.parse(
    read('apps/desktop/src-tauri/tauri.conf.json'),
  ).version,
  'apps/desktop/src-tauri/Cargo.toml': tomlString(cargoPackage, 'version'),
  'apps/desktop/src-tauri/Cargo.lock': tomlString(lockEntry, 'version'),
};

const wrong = Object.entries(found).filter(([, version]) => version !== expected);
for (const [path, version] of wrong) {
  process.stderr.write(`${path}: version is ${String(version)}, expected ${expected}\n`);
}
process.exit(wrong.length === 0 ? 0 : 1);
