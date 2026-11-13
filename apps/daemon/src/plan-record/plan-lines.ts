import type { AnchorCheckDto, PlanAnchor, PlanContext, PlanItemDropped } from '@10db/contracts';

// One brief line per Plan item, so what the budget counts is exactly what the lane reads. The brief's
// block (`briefing/plan-context-text.ts`) is made of these lines.

/** A cited item of a Plan, as the brief carries it. */
export type PlanItem =
  | { readonly group: 'decision'; readonly item: PlanContext['decisions'][number] }
  | { readonly group: 'name'; readonly item: PlanContext['names'][number] }
  | { readonly group: 'fact'; readonly item: PlanContext['facts'][number] }
  | { readonly group: 'finding'; readonly item: PlanContext['findings'][number] }
  | { readonly group: 'intent'; readonly item: PlanContext['intent'][number] };

/** An anchor in words by its newest check; only an exact match at its line reads "checked at". */
function anchorText(anchor: PlanAnchor, check: AnchorCheckDto | undefined): string {
  if (anchor.kind === 'url') return `${anchor.url}, read ${anchor.readAt}`;
  const at = `${anchor.path}:${String(anchor.line)}`;
  if (check === undefined) return `Anchor not checked yet: ${at}`;
  switch (check.result) {
    case 'current':
      return check.checkedCommit === null
        ? `Anchor not checked yet: ${at}`
        : `${at}, checked at ${check.checkedCommit.slice(0, 7)}`;
    case 'moved':
      return `Anchor moved: ${anchor.path}:${String(anchor.line)}→${String(check.line ?? '?')}`;
    case 'changed':
      return `Anchor changed: ${at}, the excerpt is not there`;
    case 'unchecked':
      return `Anchor not checked: ${check.note ?? 'no reason given'}`;
    case 'url':
      return `Anchor not checked yet: ${at}`;
  }
}

/** A fact's or experiment's anchors in words, each by the check of its own index. */
function anchorsText(fact: PlanContext['facts'][number]): string {
  return fact.anchors
    .map((anchor, i) =>
      anchorText(
        anchor,
        fact.checks.find((c) => c.anchorIndex === i),
      ),
    )
    .join('; ');
}

/** ` (superseded)` or ` (rejected)` for an item that no longer stands, else nothing. */
const droppedText = (dropped: PlanItemDropped | null): string =>
  dropped === null ? '' : ` (${dropped})`;

export function planItemLine(entry: PlanItem): string {
  switch (entry.group) {
    case 'decision': {
      const d = entry.item;
      return `- ${d.key}: ${d.choice} — why: ${d.rationale} (${d.lasting ? 'lasting' : 'this effort'})${droppedText(d.dropped)}`;
    }
    case 'name':
      return `- ${entry.item.name} — ${entry.item.definition}${droppedText(entry.item.dropped)}`;
    case 'fact': {
      // A superseded fact's anchors were never checked, so they are left out of its line.
      if (entry.item.dropped !== null)
        return `- ${entry.item.key}: ${entry.item.line}${droppedText(entry.item.dropped)}`;
      const anchors = anchorsText(entry.item);
      return `- ${entry.item.key}: ${entry.item.line}${anchors === '' ? '' : ` — ${anchors}`}`;
    }
    case 'finding':
      return `- ${entry.item.severity}: ${entry.item.text}`;
    case 'intent':
      return `- "${entry.item.quote}" — ${entry.item.speaker}${droppedText(entry.item.dropped)}`;
  }
}
