const MICROS = 1_000_000n;

/** A Slack `ts` ("1731300000.000100") as microseconds since the epoch, so two compare as numbers. */
function tsMicros(ts: string): bigint {
  const [seconds = '0', fraction = ''] = ts.split('.');
  try {
    return BigInt(seconds) * MICROS + BigInt(fraction.padEnd(6, '0').slice(0, 6));
  } catch {
    return 0n;
  }
}

/** Orders two Slack timestamps: negative when `a` is older than `b`. */
export function compareTs(a: string, b: string): number {
  const x = tsMicros(a);
  const y = tsMicros(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** A Slack `ts` as milliseconds since the epoch. */
export function tsMillis(ts: string): number {
  return Number(tsMicros(ts) / 1000n);
}
