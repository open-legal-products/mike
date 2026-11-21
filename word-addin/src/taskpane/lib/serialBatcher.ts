/** Coalesce ready work, then drain arrivals after each in-flight batch settles. */
export function createSerialBatcher<I, O>(run: (inputs: I[]) => Promise<O[]>): (input: I) => Promise<O> {
  type Request = { input: I; resolve: (value: O) => void; reject: (error: unknown) => void };
  let pending: Request[] = [];
  let scheduled = false;
  async function drain(): Promise<void> {
    while (pending.length) {
      const batch = pending;
      pending = [];
      try {
        const results = await run(batch.map(request => request.input));
        if (results.length !== batch.length) throw new Error("Word did not return every edit result.");
        batch.forEach((request, index) => request.resolve(results[index]!));
      } catch (error) {
        for (const request of batch) request.reject(error);
      }
    }
    scheduled = false;
  }
  return input => new Promise<O>((resolve, reject) => {
    pending.push({ input, resolve, reject });
    if (!scheduled) {
      scheduled = true;
      // Allow async per-card persistence callbacks in this turn to join the batch.
      setTimeout(() => { void drain(); }, 0);
    }
  });
}
