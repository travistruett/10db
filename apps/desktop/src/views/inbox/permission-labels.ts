import { InboxKind, PermissionChoice, type InboxItemDto, type InboxOption } from '@10db/contracts';
import { MCP_APPROVAL_LABELS, mcpReview } from './mcp-approval';

/** The daemon stores permission choices as stable values; the builder reads words. */
export const PERMISSION_LABELS: Readonly<Record<PermissionChoice, string>> = {
  [PermissionChoice.AllowOnce]: 'Allow once',
  [PermissionChoice.AllowWorkstream]: 'Allow for this workstream',
  [PermissionChoice.AllowProject]: 'Always allow in this project',
  [PermissionChoice.Deny]: 'Deny',
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

export function optionLabel(item: InboxItemDto, option: InboxOption): string {
  if (item.kind === InboxKind.Permission && isPermissionChoice(option.label))
    return PERMISSION_LABELS[option.label];
  if (mcpReview(item)) return MCP_APPROVAL_LABELS[option.label] ?? option.label;
  return option.label;
}
