import { execFile } from 'node:child_process';
import { connect } from 'node:net';

/** How long one connect to an engine socket waits before it counts as not answering. */
const SOCKET_TIMEOUT_MS = 1_000;

/** Whether something accepts a connection at the Unix socket `path`. */
function socketAnswers(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(path);
    const done = (answered: boolean): void => {
      socket.destroy();
      resolve(answered);
    };
    socket.setTimeout(SOCKET_TIMEOUT_MS, () => {
      done(false);
    });
    socket.once('connect', () => {
      done(true);
    });
    socket.once('error', () => {
      done(false);
    });
  });
}

/** Whether any of the Docker engine sockets accepts a connection: Desktop, Colima, OrbStack or Rancher. */
export async function dockerAnswers(sockets: readonly string[]): Promise<boolean> {
  const answers = await Promise.all(sockets.map(socketAnswers));
  return answers.some(Boolean);
}

/** Opens Docker Desktop (`open -a Docker`); rejects with what `open` said when it can't. */
export function openDockerDesktop(): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('open', ['-a', 'Docker'], (error, _stdout, stderr) => {
      if (error === null) resolve();
      else reject(new Error(stderr.trim() === '' ? error.message : stderr.trim()));
    });
  });
}
