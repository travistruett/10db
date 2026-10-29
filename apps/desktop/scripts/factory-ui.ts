import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  checkFactoryConnection,
  FactoryConnectionError,
  readFactoryConnection,
  VITE_ORIGIN,
} from './factory-connection';
import { factoryViteCommand, viteStartFailure } from './factory-vite';

// Serves the checkout's UI with hot reload over the installed app's daemon: the builder's real
// projects and Inbox. It starts no daemon of its own. The factory's data directory is the installed
// app's default; `TENDB_DATA_DIR` is not read, because `pnpm dev` points it at `.dev/data`.
const desktop = resolve(import.meta.dirname, '..');
const factoryDataDir = join(homedir(), 'Library', 'Application Support', '10db');

let connection;
try {
  connection = readFactoryConnection(factoryDataDir);
  await checkFactoryConnection(connection, VITE_ORIGIN);
} catch (error) {
  if (!(error instanceof FactoryConnectionError)) throw error;
  console.error(error.message);
  process.exit(1);
}

console.log(
  `10db dev UI over the factory's daemon at ${connection.url}. Open ${VITE_ORIGIN}. It acts on your real data; when 10db restarts, its token changes, so run this again.`,
);
const command = factoryViteCommand(connection);
const vite = spawn(command.file, [...command.args], {
  cwd: desktop,
  stdio: 'inherit',
  env: { ...process.env, ...command.env },
});
vite.on('error', (error) => {
  console.error(viteStartFailure(error));
  process.exit(1);
});
vite.on('exit', (code) => {
  process.exit(code ?? 1);
});
