import { InboxKind } from '@10db/contracts';
import {
  IconBulb,
  IconChecklist,
  IconEye,
  IconFlag,
  IconListDetails,
  IconMessageQuestion,
  IconSettings,
  IconShieldLock,
  type Icon,
} from '@tabler/icons-react';

/** The mark a card's row and header show for what the card is; its name is `KIND_LABELS`. */
export const KIND_ICONS: Readonly<Record<InboxKind, Icon>> = {
  [InboxKind.Question]: IconMessageQuestion,
  [InboxKind.Permission]: IconShieldLock,
  [InboxKind.Proposal]: IconBulb,
  [InboxKind.Review]: IconEye,
  [InboxKind.Flag]: IconFlag,
  [InboxKind.Check]: IconChecklist,
  [InboxKind.Plan]: IconListDetails,
  [InboxKind.PlaybookMoveReport]: IconSettings,
};
