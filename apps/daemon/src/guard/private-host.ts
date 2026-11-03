/** Hosts that name a machine of the builder's own network, not the public web. */
const LOCAL_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home.arpa', '.intranet'];

/** True when a lower-case host name reads as this machine or the builder's own network. */
export function namesPrivateHost(host: string): boolean {
  return (
    !host.includes('.') || host === 'localhost' || LOCAL_SUFFIXES.some((s) => host.endsWith(s))
  );
}
