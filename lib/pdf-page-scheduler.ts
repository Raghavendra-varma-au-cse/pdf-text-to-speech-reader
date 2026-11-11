export interface OrderedPoolOptions<T> {
  /** Number of work items. Items are numbered 1..total, inclusive. */
  total: number;
  /** Maximum number of workers running at once. */
  concurrency: number;
  /** Runs one item. Workers may finish out of order. */
  worker: (index: number) => Promise<T>;
  /**
   * Called on the main thread in strict index order, even when the workers
   * finish out of order. This is what keeps text-segment indices stable while
   * pages are parsed in parallel.
   */
  onResult: (index: number, result: T) => void;
  signal?: AbortSignal;
}

/**
 * Run `worker` for 1..total with bounded concurrency, then emit results in
 * ascending order. If any worker fails, in-flight work is allowed to settle and
 * the first error is re-thrown.
 */
export async function runOrderedPool<T>({
  total,
  concurrency,
  worker,
  onResult,
  signal,
}: OrderedPoolOptions<T>): Promise<void> {
  if (total <= 0) return;

  const limit = Math.max(1, Math.min(concurrency, total));
  const finished = new Map<number, T>();
  let nextToStart = 1;
  let nextToEmit = 1;
  let firstError: unknown = null;

  const emitReady = () => {
    while (nextToEmit <= total && finished.has(nextToEmit)) {
      const result = finished.get(nextToEmit) as T;
      finished.delete(nextToEmit);
      onResult(nextToEmit, result);
      nextToEmit++;
    }
  };

  const runners = Array.from({ length: limit }, async () => {
    while (true) {
      if (signal?.aborted || firstError !== null) return;

      const index = nextToStart;
      nextToStart++;
      if (index > total) return;

      try {
        const result = await worker(index);
        if (signal?.aborted) return;
        finished.set(index, result);
        emitReady();
      } catch (error) {
        if (!signal?.aborted && firstError === null) firstError = error;
        return;
      }
    }
  });

  await Promise.all(runners);

  if (firstError !== null) throw firstError;
}
