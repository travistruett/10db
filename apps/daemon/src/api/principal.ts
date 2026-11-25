import { TicketScope } from '@10db/contracts';
import type { DeviceId } from '@10db/contracts';

/** Who a request or stream ticket belongs to once its credential is checked. */
export type Principal =
  | { readonly kind: 'this_mac' }
  | { readonly kind: 'dev_ui' }
  | { readonly kind: 'render' }
  | { readonly kind: 'device'; readonly deviceId: DeviceId }
  | { readonly kind: 'none' };

/** The stream-ticket scope a principal may mint; null when it may not mint one. */
export function ticketScopeOf(p: Principal): TicketScope | null {
  switch (p.kind) {
    case 'this_mac':
    case 'device':
      return TicketScope.Full;
    case 'dev_ui':
      return TicketScope.DevUi;
    case 'render':
    case 'none':
      return null;
  }
}
