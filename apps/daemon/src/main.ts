import { AlreadyRunningError, startDaemon } from './daemon';
import { loadEnv } from './env';
import { resolveDataDir, resolveMigrationsDir } from './paths';
import { createUnavailableAdapter, FakeAdapter, loadFakeScriptBook } from './sessions';

// An unhandled error exits loudly; the supervisor restarts the daemon and recovery runs at startup.
process.on('unhandledRejection', (error) => {
  console.error('10db daemon: unhandled rejection', error);
  process.exit(1);
});
process.on('uncaughtException', (error) => {
  console.error('10db daemon: uncaught exception', error);
  process.exit(1);
});

const env = loadEnv(process.env);
const dataDir = resolveDataDir(env);
const adapter = env.TENDB_FAKE_SCRIPTS
  ? new FakeAdapter(loadFakeScriptBook(env.TENDB_FAKE_SCRIPTS))
  : createUnavailableAdapter('No session adapter is configured');

try {
  const daemon = await startDaemon({
    dataDir,
    port: env.TENDB_PORT,
    adapter,
    logLevel: env.TENDB_LOG_LEVEL,
    migrationsDir: resolveMigrationsDir(),
  });
  console.log(`10db daemon listening on ${daemon.url} (data: ${dataDir})`);
  const shutdown = (): void => {
    void daemon.stop().then(() => {
      process.exit(0);
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
} catch (error) {
  if (error instanceof AlreadyRunningError) {
    console.error(error.message);
    process.exit(2);
  }
  throw error;
}
