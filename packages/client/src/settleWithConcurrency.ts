export async function settleWithConcurrency<TItem, TResult>(
    items: readonly TItem[],
    concurrency: number,
    worker: (item: TItem, index: number) => Promise<TResult>,
): Promise<PromiseSettledResult<TResult>[]> {
    if (items.length === 0) return [];
    const results = new Array<PromiseSettledResult<TResult>>(items.length);
    const workerCount = Math.min(
        items.length,
        Math.max(1, Math.floor(concurrency)),
    );
    let nextIndex = 0;

    const runWorker = async () => {
        while (nextIndex < items.length) {
            const index = nextIndex;
            nextIndex += 1;
            try {
                results[index] = {
                    status: "fulfilled",
                    value: await worker(items[index]!, index),
                };
            } catch (reason) {
                results[index] = { status: "rejected", reason };
            }
        }
    };

    await Promise.all(Array.from({ length: workerCount }, runWorker));
    return results;
}
