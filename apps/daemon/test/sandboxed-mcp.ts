import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { mintId } from '@10db/contracts';
import { createGit } from '../src/git';
import { createLaneSandbox, type SandboxedMcpServer, type StdioMcpServer } from '../src/sandbox';
import { createTempRepo, FAKE_SRT } from './fixtures';

/**
 * A stdio server as a real lane sandbox launches it, with srt's stand-in, the only way to make one.
 * Its root is a short path under the shared `/tmp`, which no sandbox can write: callers skip with
 * `SANDBOXED`.
 */
export async function sandboxedMcpServer(
  server: StdioMcpServer,
): Promise<{ readonly server: SandboxedMcpServer; cleanup(): void }> {
  const root = realpathSync(mkdtempSync('/tmp/sbx-'));
  const repo = createTempRepo();
  const cleanup = (): void => {
    repo.cleanup();
    rmSync(root, { recursive: true, force: true });
  };
  try {
    const home = join(root, 'h');
    const tmpRoot = join(root, 't');
    mkdirSync(home);
    mkdirSync(tmpRoot);
    const git = createGit();
    const session = await createLaneSandbox({
      home,
      dataDir: join(home, 'data'),
      loginConfigDir: null,
      tmpRoot,
      gitDirs: (path) => git.gitDirs(path),
      systemPrefixes: [],
      runtime: FAKE_SRT,
    }).forSession({
      project: {
        id: mintId('Project'),
        repoPath: repo.path,
        sandboxLoopback: false,
        gateCommand: 'make gate',
      },
      env: { PATH: '/usr/bin:/bin', HOME: home },
      rules: [],
      resumeProviderSessionId: null,
      configDir: join(home, '.claude'),
      checkouts: [repo.path],
      mcpServers: { server },
    });
    const sandboxed = session.mcpServers['server'];
    if (sandboxed === undefined) throw new Error('the lane sandbox made no server');
    return {
      server: sandboxed,
      cleanup: () => {
        session.dispose();
        cleanup();
      },
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}
