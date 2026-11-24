function plainHost(host: string): string {
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  return bare.toLowerCase().replace(/^::ffff:/, '');
}

/**
 * The pids of an `lsof -F pn` listing that hold the server end of the probe's connection: a socket named
 * exactly `<server address>:<port>-><probe address>:<probe port>`. A socket that only mentions the probe's
 * port (an outbound connection to some host's port, the daemon's own client end) is not one.
 */
export function parseAcceptors(
  output: string,
  probe: {
    readonly server: string;
    readonly port: number;
    readonly client: string;
    readonly clientPort: number;
  },
): number[] {
  const pids = new Set<number>();
  let pid: number | null = null;
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) {
      const next = Number(line.slice(1));
      pid = Number.isInteger(next) ? next : null;
      continue;
    }
    if (!line.startsWith('n') || pid === null) continue;
    const match = /^(.+):(\d+)->(.+):(\d+)$/.exec(line.slice(1));
    if (match === null) continue;
    if (
      Number(match[2]) === probe.port &&
      Number(match[4]) === probe.clientPort &&
      plainHost(match[1] ?? '') === plainHost(probe.server) &&
      plainHost(match[3] ?? '') === plainHost(probe.client)
    ) {
      pids.add(pid);
    }
  }
  return [...pids];
}
