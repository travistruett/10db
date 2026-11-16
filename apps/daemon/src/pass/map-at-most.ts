/**
 * `items` mapped through `run`, in order, with at most `limit` runs pending at once. The slots share
 * one iterator, so each run that ends takes the next item and a slow item holds back only its own slot.
 * Once a run fails, no slot takes another item: the caller has its rejection and wants no more work.
 */
export async function mapAtMost<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = [];
  const queue = items.entries();
  let failed = false;
  const slot = async (): Promise<void> => {
    for (const [i, item] of queue) {
      if (failed) return;
      try {
        out[i] = await run(item);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, slot));
  return out;
}
