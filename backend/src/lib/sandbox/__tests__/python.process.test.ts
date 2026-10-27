import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PythonRunner } from "../python";

const childPath = path.join(__dirname, "fakePythonChild.ts");
const runners: PythonRunner[] = [];
const runner = (options: ConstructorParameters<typeof PythonRunner>[0] = {}) => {
    const instance = new PythonRunner({ childPath, ...options });
    instance.available = () => true;
    runners.push(instance);
    return instance;
};
const run = (r: PythonRunner, code: string) => r.run({ code, docs: [] });

afterEach(() => {
    for (const r of runners.splice(0)) r.shutdown();
});

describe("the python runner", () => {
    it("kills a run that outlives the wall clock", async () => {
        const r = runner({ limits: { pythonTimeoutMs: 300 } });
        await expect(run(r, "hang")).resolves.toEqual({ ok: false, code: "timeout" });
    });

    it("reports a child that exits without a result as crashed", async () => {
        await expect(run(runner(), "exit")).resolves.toEqual({ ok: false, code: "crashed" });
    });

    it("answers busy when every slot stays taken for the queue wait", async () => {
        const r = runner({ limits: { pythonConcurrency: 1, queueWaitMs: 200, pythonTimeoutMs: 5000 } });
        const first = run(r, "ok:1500");
        await new Promise((resolve) => setTimeout(resolve, 50));
        await expect(run(r, "ok")).resolves.toEqual({ ok: false, code: "busy" });
        await expect(first).resolves.toMatchObject({ ok: true, stdout: "ok" });
    });

    it("kills a run whose memory passes the limit", async () => {
        const r = runner({ limits: { pythonMemoryMb: 1 }, readRss: async () => 2 * 1024 * 1024 });
        await expect(run(r, "hang")).resolves.toEqual({ ok: false, code: "memory" });
    });
});
