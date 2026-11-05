/**
 * Wraps an array so a test can count how often its elements are read by
 * index. Array.includes / indexOf read every element up to the match, so a
 * lookup per row shows up as rows × length reads; building a Set reads each
 * element once.
 */
export function countIndexReads<T>(items: T[]) {
    const reads = { count: 0 };
    const proxy = new Proxy(items, {
        get(target, key, receiver) {
            if (typeof key === "string" && /^\d+$/.test(key)) reads.count++;
            return Reflect.get(target, key, receiver);
        },
    });
    return { proxy, reads };
}
