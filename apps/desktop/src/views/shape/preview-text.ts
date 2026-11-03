import type { ShapePreviewDto } from '@10db/contracts';

// Shape spec §10.2: the preview's words. Hours read as "1.5 h", a whole number without a decimal.

/** Hours to one decimal, with no trailing ".0". */
export function hoursText(hours: number): string {
  return `${String(Math.round(hours * 10) / 10)} h`;
}

const lanes = (hours: number): string => {
  const n = Math.round(hours * 10) / 10;
  return `${String(n)} lane ${n === 1 ? 'hour' : 'hours'}`;
};

/** "3 tasks · 4.5 lane hours · ends in about 9 h (estimate)". */
export function previewSummary(preview: ShapePreviewDto): string {
  return [
    `${String(preview.tasks)} ${preview.tasks === 1 ? 'task' : 'tasks'}`,
    lanes(preview.totalLaneHours),
    `ends in about ${hoursText(preview.endEstimateHours)} (estimate)`,
  ].join(' · ');
}
