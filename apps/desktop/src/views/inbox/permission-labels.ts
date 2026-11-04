import {
  InboxKind,
  PermissionChoice,
  PrincipleVerdict,
  type InboxItemDto,
  type InboxOption,
} from '@10db/contracts';
import { MCP_APPROVAL_LABELS, mcpReview } from './mcp-approval';

/** The daemon stores permission choices as stable values; the builder reads words. */
export const PERMISSION_LABELS: Readonly<Record<PermissionChoice, string>> = {
  [PermissionChoice.AllowOnce]: 'Allow once',
  [PermissionChoice.AllowWorkstream]: 'Allow for this workstream',
  [PermissionChoice.AllowProject]: 'Always allow in this project',
  [PermissionChoice.Deny]: 'Deny',
};

/** A principle proposal card's choices, in words; the area one gets its area's name (`optionLabel`). */
export const PRINCIPLE_VERDICT_LABELS: Readonly<Record<PrincipleVerdict, string>> = {
  [PrincipleVerdict.AcceptProject]: 'This project',
  [PrincipleVerdict.AcceptYou]: 'All my projects',
  [PrincipleVerdict.AcceptArea]: 'This area',
  [PrincipleVerdict.Reject]: 'Reject',
};

export const KIND_LABELS: Readonly<Record<InboxKind, string>> = {
  [InboxKind.Question]: 'Question',
  [InboxKind.Permission]: 'Permission',
  [InboxKind.Proposal]: 'Proposal',
  [InboxKind.Review]: 'Review',
  [InboxKind.Flag]: 'Flag',
  [InboxKind.Check]: 'Check',
};

function isPermissionChoice(label: string): label is PermissionChoice {
  return Object.hasOwn(PERMISSION_LABELS, label);
}

function isPrincipleVerdict(label: string): label is PrincipleVerdict {
  return Object.hasOwn(PRINCIPLE_VERDICT_LABELS, label);
}

/** A proposal card about a principle: the daemon puts the principle's id in its detail. */
export function isPrincipleCard(item: InboxItemDto): boolean {
  return item.kind === InboxKind.Proposal && typeof item.detail?.['principleId'] === 'string';
}

/**
 * An option as the builder reads it. `area` is the name of the area a principle proposal is for, when
 * known; the area choice names it.
 */
export function optionLabel(
  item: InboxItemDto,
  option: InboxOption,
  area: string | null = null,
): string {
  if (item.kind === InboxKind.Permission && isPermissionChoice(option.label))
    return PERMISSION_LABELS[option.label];
  if (mcpReview(item)) return MCP_APPROVAL_LABELS[option.label] ?? option.label;
  if (isPrincipleCard(item) && isPrincipleVerdict(option.label)) {
    const words = PRINCIPLE_VERDICT_LABELS[option.label];
    return option.label === PrincipleVerdict.AcceptArea && area !== null
      ? `${words} (${area})`
      : words;
  }
  return option.label;
}
