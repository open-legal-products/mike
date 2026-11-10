export type KeyedLock = {
  /** Resolves to the release function. */
  acquire(key: string): Promise<() => void>;
  run<T>(key: string, fn: () => Promise<T>): Promise<T>;
};

export function createKeyedLock(): KeyedLock {
  const tails = new Map<string, Promise<void>>();
  const acquire = async (key: string) => {
    const previous = tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => released);
    tails.set(key, tail);
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    await previous;
    return release;
  };
  return {
    acquire,
    async run(key, fn) {
      const release = await acquire(key);
      try {
        return await fn();
      } finally {
        release();
      }
    },
  };
}
