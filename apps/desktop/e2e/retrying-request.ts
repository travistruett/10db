import type { APIRequestContext, APIResponse } from '@playwright/test';

/**
 * How many times Playwright resends a request after a reset connection. A request can reuse a keep-alive
 * socket the daemon closed after its idle timeout, and Playwright retries only ECONNRESET, and only for a
 * request that sets `maxRetries`.
 */
export const RESET_RETRIES = 2;

const RETRIED_METHODS = ['delete', 'fetch', 'get', 'head', 'patch', 'post', 'put'] as const;

type RetriedMethod = (typeof RETRIED_METHODS)[number];
type RequestOptions = Parameters<APIRequestContext['get']>[1];
type Send = (target: string, options?: RequestOptions) => Promise<APIResponse>;

function isRetriedMethod(name: string | symbol): name is RetriedMethod {
  return RETRIED_METHODS.some((method) => method === name);
}

/**
 * The request context with `maxRetries` set on every request that doesn't set its own, so a spec's API
 * calls survive a reset connection without each call saying so.
 */
export function withResetRetries(request: APIRequestContext): APIRequestContext {
  return new Proxy(request, {
    get(target, name) {
      // The Proxy handler is untyped: `Reflect.get` returns the context's member as `unknown`.
      const member: unknown = Reflect.get(target, name, target);
      if (typeof member !== 'function') return member;
      // A method must run on the context itself, not on the Proxy.
      if (!isRetriedMethod(name)) {
        return (...args: unknown[]): unknown => Reflect.apply(member, target, args);
      }
      return (url: string, options?: RequestOptions) =>
        // The member is the context's own method for this name, which takes a URL and request options.
        (member as Send).call(target, url, { maxRetries: RESET_RETRIES, ...options });
    },
  });
}
