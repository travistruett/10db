import type { AreaNamer } from './propose-areas';

/**
 * The model's answer to `prompt`, or null when it fails, is not back within `ms`, or the caller gives
 * up. One signal ends the question whichever way it ends, so nothing it started keeps running, and an
 * asker that ignores its signal still holds no caller past the bound.
 */
export async function askWithin(
  asker: AreaNamer,
  prompt: string,
  ms: number,
  caller?: AbortSignal,
): Promise<string | null> {
  if (caller?.aborted === true) return null;
  const question = new AbortController();
  const stop = (): void => {
    question.abort();
  };
  const timer = setTimeout(stop, ms);
  caller?.addEventListener('abort', stop, { once: true });
  const ended = new Promise<null>((resolve) => {
    question.signal.addEventListener(
      'abort',
      () => {
        resolve(null);
      },
      { once: true },
    );
  });
  try {
    const asked = asker(prompt, question.signal);
    asked.catch(() => undefined);
    return await Promise.race([asked, ended]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    caller?.removeEventListener('abort', stop);
    question.abort();
  }
}
