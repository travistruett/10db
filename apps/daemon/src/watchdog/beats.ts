// The memory the main thread and the watchdog worker share: a beat counter the main thread adds to,
// and the hosts of its open outbound calls, comma-joined.

/** How long the main thread may go without a beat before it is logged, sampled and killed. */
export const STALL_MS = 15_000;
/** How often the main thread beats and the worker looks. */
export const BEAT_MS = 1_000;
/** Longest `/usr/bin/sample` may take before the kill goes ahead without it. */
export const SAMPLE_TIMEOUT_MS = 10_000;
/** How many stall samples are kept beside the log. */
export const SAMPLES_KEPT = 5;

export const SAMPLE_PREFIX = 'daemon-stall-';
export const SAMPLE_SUFFIX = '.sample.txt';

/** Where each part lives: the two Int32 slots by index, the hosts by byte offset. */
export const BeatLayout = {
  CounterIndex: 0,
  HostsLengthIndex: 1,
  HostsOffset: 8,
  HostsBytes: 1024,
} as const;

export const BEATS_BYTES = BeatLayout.HostsOffset + BeatLayout.HostsBytes;

/** Writes `hosts` for the worker to read; what does not fit is dropped. */
export function writeHosts(beats: SharedArrayBuffer, hosts: readonly string[]): void {
  const slots = new Int32Array(beats, 0, 2);
  const bytes = new TextEncoder().encode(hosts.join(',')).subarray(0, BeatLayout.HostsBytes);
  // Zero length while the bytes change, so a reader never takes half of each list.
  Atomics.store(slots, BeatLayout.HostsLengthIndex, 0);
  new Uint8Array(beats, BeatLayout.HostsOffset, BeatLayout.HostsBytes).set(bytes);
  Atomics.store(slots, BeatLayout.HostsLengthIndex, bytes.length);
}

/** The hosts last written. */
export function readHosts(beats: SharedArrayBuffer): string[] {
  const length = Atomics.load(new Int32Array(beats, 0, 2), BeatLayout.HostsLengthIndex);
  // A decoder takes no shared memory, so the bytes are copied out first.
  const bytes = new Uint8Array(beats, BeatLayout.HostsOffset, BeatLayout.HostsBytes).slice(
    0,
    Math.min(Math.max(length, 0), BeatLayout.HostsBytes),
  );
  const text = new TextDecoder().decode(bytes);
  return text === '' ? [] : text.split(',');
}
