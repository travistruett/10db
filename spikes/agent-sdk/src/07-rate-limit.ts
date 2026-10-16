// Spike 7: summarizes every rate_limit_event recorded by the other probes and infers the units of resetsAt by
// comparing it with the wall clock at the moment it was recorded.
import { existsSync, readFileSync } from 'node:fs';
import { check, finish, info, outPath, partial } from './report.ts';

type Row = {
  recordedAt: number;
  spike: string;
  info: {
    status: string;
    resetsAt?: number;
    rateLimitType?: string;
    utilization?: number;
    overageStatus?: string;
    overageResetsAt?: number;
    isUsingOverage?: boolean;
    overageInUse?: boolean;
    overageDisabledReason?: string;
  };
};
const read = <T,>(file: string): T[] =>
  existsSync(outPath(file)) ? readFileSync(outPath(file), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as T) : [];

const rows = read<Row>('rate-limit-events.jsonl');
const errors = read<{ spike: string; error: string }>('assistant-errors.jsonl');
info('events recorded', rows.length);
info('distinct statuses', [...new Set(rows.map((r) => r.info.status))]);
info('distinct rateLimitType', [...new Set(rows.map((r) => r.info.rateLimitType ?? 'none'))]);
info('assistant errors', errors);
// On Max with extra usage enabled, hitting the plan limit may spend money instead of pausing; record every
// overage field seen so M1b can decide how to treat it.
info('overage fields', rows.map((r) => ({ overageStatus: r.info.overageStatus ?? null, isUsingOverage: r.info.isUsingOverage ?? null, overageInUse: r.info.overageInUse ?? null, overageDisabledReason: r.info.overageDisabledReason ?? null, overageResetsAt: r.info.overageResetsAt ?? null })).slice(0, 5));
info('any event using overage', rows.some((r) => r.info.isUsingOverage === true || r.info.overageInUse === true || r.info.rateLimitType === 'overage'));

const withReset = rows.filter((r) => typeof r.info.resetsAt === 'number');
const units = withReset.map((r) => {
  const v = r.info.resetsAt ?? 0;
  const asMs = v > 1e12 ? v : v * 1000;
  return { unit: v > 1e12 ? 'ms' : 's', hoursAhead: Math.round(((asMs - r.recordedAt) / 3_600_000) * 10) / 10, rateLimitType: r.info.rateLimitType ?? 'none' };
});
info('resetsAt samples', units.slice(0, 5));

if (rows.length === 0) partial('rate_limit_event observed', 'none recorded; rerun spikes 02–06 on the subscription');
else check('rate_limit_event observed', true, `${rows.length} event(s)`);
if (withReset.length === 0) partial('resetsAt units', 'no event carried resetsAt');
else {
  const sameUnit = new Set(units.map((u) => u.unit)).size === 1;
  const plausible = units.every((u) => u.hoursAhead > 0 && u.hoursAhead <= 24 * 8);
  check('resetsAt units consistent and plausible (0–8 days ahead)', sameUnit && plausible, JSON.stringify(units.slice(0, 3)));
}
partial('rejected status observed', rows.some((r) => r.info.status === 'rejected') ? 'yes — see events' : 'not forced (by design); handling is designed from the types');
finish();
