export type Slots = { acquire(): Promise<boolean>; release(): void };

/** `limit` holders at a time; a caller that waits longer than `waitMs` for a slot gets false. */
export function createSlots(limit: number, waitMs: number): Slots {
    let active = 0;
    const waiting: Array<() => void> = [];
    return {
        acquire() {
            if (active < limit) {
                active++;
                return Promise.resolve(true);
            }
            return new Promise((resolve) => {
                const timer = setTimeout(() => {
                    waiting.splice(waiting.indexOf(grant), 1);
                    resolve(false);
                }, waitMs);
                const grant = () => {
                    clearTimeout(timer);
                    active++;
                    resolve(true);
                };
                waiting.push(grant);
            });
        },
        release() {
            active--;
            waiting.shift()?.();
        },
    };
}
