/** How long one look at the app address waits for an answer. */
const PROBE_TIMEOUT_MS = 1_000;

/**
 * Whether anything answers at the app address: any HTTP response counts, an error page included,
 * since a dev server that answers 500 is running. A refused or silent address does not.
 */
export async function answers(appUrl: string): Promise<boolean> {
  try {
    const response = await fetch(appUrl, {
      redirect: 'manual',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    await response.body?.cancel();
    return true;
  } catch {
    return false;
  }
}
