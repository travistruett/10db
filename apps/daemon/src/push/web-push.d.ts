// web-push 4 ships no types; this is the part 10db uses.
declare module 'web-push' {
  export interface PushSubscription {
    readonly endpoint: string;
    readonly keys: { readonly p256dh: string; readonly auth: string };
  }
  export interface SendOptions {
    readonly vapidDetails?: {
      readonly subject: string;
      readonly publicKey: string;
      readonly privateKey: string;
    };
    readonly TTL?: number;
    readonly urgency?: 'very-low' | 'low' | 'normal' | 'high';
  }
  export class WebPushError extends Error {
    readonly statusCode: number;
  }
  export function generateVAPIDKeys(): { publicKey: string; privateKey: string };
  export function sendNotification(
    subscription: PushSubscription,
    payload: string,
    options?: SendOptions,
  ): Promise<unknown>;
}
