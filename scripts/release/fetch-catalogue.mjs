#!/usr/bin/env node
// Writes the model catalogue a release carries: models.dev's document cut to the providers the daemon reads, with
// every other provider kept by name only, because the daemon names a Bedrock model's maker by the providers listed.
// The daemon starts from it until its first fetch succeeds. A fetch that fails, or an answer that is not a
// catalogue, fails the build rather than ship a release with none.
// Usage: node scripts/release/fetch-catalogue.mjs <out-file> [url]
// Exit 0: written. Exit 1: nothing written (the reason is printed). Exit 2: bad argument.
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

// The providers `CATALOGUE_PROVIDERS` in apps/daemon/src/catalogue/source.ts names; a repo test keeps them equal.
const PROVIDERS = ['anthropic', 'openai', 'amazon-bedrock', 'openrouter'];
const DEFAULT_URL = 'https://models.dev/api.json';
const TIMEOUT_MS = 60_000;

const out = process.argv[2];
if (!out) {
  process.stderr.write('usage: fetch-catalogue.mjs <out-file> [url]\n');
  process.exit(2);
}
const url = process.argv[3] ?? DEFAULT_URL;

function fail(message) {
  process.stderr.write(`fetch-catalogue.mjs: ${message}\n`);
  process.exit(1);
}

const filled = (value) => typeof value === 'string' && value !== '';
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

let response;
try {
  response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
} catch (error) {
  fail(`could not reach ${url}: ${error instanceof Error ? error.message : String(error)}`);
}
if (!response.ok) fail(`${url} answered ${String(response.status)}`);

let document;
try {
  document = await response.json();
} catch {
  fail(`${url} answered something that is not JSON`);
}
if (!isObject(document)) fail(`${url} answered something that is not an object`);

// Names only: the daemon reads no model of these, but a Bedrock ID such as `mistral.x` is matched against them.
const kept = Object.fromEntries(Object.keys(document).map((name) => [name, {}]));
for (const provider of PROVIDERS) {
  const models = document[provider]?.models;
  if (!isObject(models)) fail(`the ${provider} provider is missing or lists no models`);
  // The daemon keeps an entry only with an id and a name; a provider with none would be rejected whole.
  if (
    !Object.values(models).some(
      (entry) => isObject(entry) && filled(entry.id) && filled(entry.name),
    )
  )
    fail(`the ${provider} provider has no model with an id and a name`);
  kept[provider] = document[provider];
}

mkdirSync(dirname(out), { recursive: true });
// Written whole or not at all, so an interrupted run never leaves half a file for the bundle to carry.
const partial = `${out}.partial`;
writeFileSync(partial, JSON.stringify(kept));
renameSync(partial, out);
process.stdout.write(`fetch-catalogue.mjs: wrote ${PROVIDERS.length} providers to ${out}\n`);
