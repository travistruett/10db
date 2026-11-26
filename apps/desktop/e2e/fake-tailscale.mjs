#!/usr/bin/env node
// A stand-in for the Tailscale CLI, for the e2e's daemon (`TENDB_TAILSCALE_CLI`). It answers what
// apps/daemon/src/sharing reads: `status --json`, `serve status --json`, `serve --bg --https=<port> <target>`,
// `serve --https=<port> off` and `cert`. The serve mapping lives in a file, because every call is a new process.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const FAKE_FQDN = 'mac.e2e.ts.net';
const STATE = join(import.meta.dirname, '..', 'test-results', 'fake-tailscale-serve.json');

function readServe() {
  try {
    return JSON.parse(readFileSync(STATE, 'utf8'));
  } catch {
    return {};
  }
}

function writeServe(serve) {
  mkdirSync(join(STATE, '..'), { recursive: true });
  writeFileSync(STATE, JSON.stringify(serve));
}

const args = process.argv.slice(2);
if (args[0] === 'status' && args.includes('--json')) {
  process.stdout.write(
    JSON.stringify({
      BackendState: 'Running',
      Version: '1.99.0-e2e',
      CertDomains: [FAKE_FQDN],
      Self: { DNSName: `${FAKE_FQDN}.`, UserID: 1, Tags: null },
      User: { 1: { LoginName: 'e2e@example.com' } },
    }),
  );
} else if (args[0] === 'serve' && args[1] === 'status') {
  process.stdout.write(JSON.stringify(readServe()));
} else if (args[0] === 'serve') {
  const https = args.find((a) => a.startsWith('--https='))?.slice('--https='.length);
  if (https === undefined) process.exit(1);
  if (args.at(-1) === 'off') {
    writeServe({});
  } else {
    const target = args.at(-1);
    writeServe({
      TCP: { [https]: { HTTPS: true } },
      Web: { [`${FAKE_FQDN}:${https}`]: { Handlers: { '/': { Proxy: target } } } },
    });
  }
} else if (args[0] === 'cert') {
  // The certificate and key go to stdout in the real one; the daemon drops it, so nothing is printed.
} else {
  process.stderr.write(`fake tailscale: no such command: ${args.join(' ')}\n`);
  process.exit(1);
}
