import { fork, type ChildProcess } from "node:child_process";
import { existsSync, readFile } from "node:fs";
import path from "node:path";
import { sandboxLimits } from "./limits";
import { createSlots, type Slots } from "./slots";
import type { PythonRequest, PythonRunOutcome } from "./types";

const WARM_IDLE_MS = 10 * 60_000;
const RSS_POLL_MS = 200;

/** Wheels fetched by scripts/fetch-pyodide-packages.mjs; the same depth from src/ and dist/. */
export const PYODIDE_PACKAGES_DIR = path.resolve(__dirname, "../../../vendor/pyodide-packages");

type Child = { process: ChildProcess; ready: Promise<boolean> };

export type PythonRunnerOptions = {
    childPath?: string;
    limits?: Partial<ReturnType<typeof sandboxLimits>>;
    readRss?: (pid: number) => Promise<number | null>;
};

/** Memory limits are enforced by the parent: a blocked interpreter cannot police itself. */
function readRss(pid: number): Promise<number | null> {
    return new Promise((resolve) => {
        readFile(`/proc/${pid}/status`, "utf8", (error, text) => {
            if (error) return resolve(null);
            const match = /VmRSS:\s+(\d+)\s+kB/.exec(text);
            resolve(match ? Number(match[1]) * 1024 : null);
        });
    });
}

export class PythonRunner {
    private warm: Child | null = null;
    private warmTimer: NodeJS.Timeout | null = null;
    private readonly slots: Slots;
    private readonly childPath: string;
    private readonly limits: ReturnType<typeof sandboxLimits>;
    private readonly readRss: (pid: number) => Promise<number | null>;

    constructor(options: PythonRunnerOptions = {}) {
        const extension = __filename.endsWith(".ts") ? "ts" : "js";
        this.childPath = options.childPath ?? path.join(__dirname, `pythonChild.${extension}`);
        this.limits = { ...sandboxLimits(), ...options.limits };
        this.slots = createSlots(this.limits.pythonConcurrency, this.limits.queueWaitMs);
        this.readRss = options.readRss ?? readRss;
    }

    available(): boolean {
        return existsSync(path.join(PYODIDE_PACKAGES_DIR, "manifest.json"));
    }

    private spawn(): Child {
        const extension = this.childPath.endsWith(".ts") ? "ts" : "js";
        const child = fork(this.childPath, [], {
            execArgv: [...(extension === "ts" ? ["--import", "tsx"] : []), "--max-old-space-size=256", "--disallow-code-generation-from-strings"],
            stdio: ["ignore", "ignore", "ignore", "ipc"],
            serialization: "advanced",
            // Nothing the interpreter runs needs deployment secrets or credentials.
            env: { NODE_ENV: process.env.NODE_ENV, PATH: process.env.PATH, TZ: "UTC" },
        });
        const ready = new Promise<boolean>((resolve) => {
            child.once("message", (message: { type?: string }) => resolve(message?.type === "ready"));
            child.once("exit", () => resolve(false));
            child.once("error", () => resolve(false));
        });
        return { process: child, ready };
    }

    private takeChild(): Child {
        const child = this.warm ?? this.spawn();
        this.warm = null;
        if (this.warmTimer) clearTimeout(this.warmTimer);
        return child;
    }

    private keepWarm() {
        if (this.warm) return;
        this.warm = this.spawn();
        this.warmTimer = setTimeout(() => {
            this.warm?.process.kill("SIGKILL");
            this.warm = null;
        }, WARM_IDLE_MS);
        this.warmTimer.unref();
    }

    async run(req: PythonRequest, opts: { signal?: AbortSignal } = {}): Promise<PythonRunOutcome> {
        if (!this.available()) return { ok: false, code: "unavailable" };
        if (!(await this.slots.acquire())) return { ok: false, code: "busy" };
        const child = this.takeChild();
        try {
            if (!(await child.ready)) return { ok: false, code: "crashed" };
            return await this.execute(child.process, req, opts.signal);
        } finally {
            // Killed after every run: interpreter state would otherwise carry
            // one user's data into the next run.
            child.process.kill("SIGKILL");
            this.slots.release();
            this.keepWarm();
        }
    }

    private execute(child: ChildProcess, req: PythonRequest, signal?: AbortSignal): Promise<PythonRunOutcome> {
        const { stdoutChars, resultBytes, maxOutputs, pythonTimeoutMs, pythonMemoryMb } = this.limits;
        return new Promise((resolve) => {
            let settled = false;
            const finish = (outcome: PythonRunOutcome) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                clearInterval(watchdog);
                signal?.removeEventListener("abort", onAbort);
                resolve(outcome);
            };
            const onAbort = () => finish({ ok: false, code: "timeout" });
            signal?.addEventListener("abort", onAbort, { once: true });
            const timer = setTimeout(() => finish({ ok: false, code: "timeout" }), pythonTimeoutMs);
            const watchdog = setInterval(() => {
                if (!child.pid) return;
                void this.readRss(child.pid).then((rss) => {
                    if (rss !== null && rss > pythonMemoryMb * 1024 * 1024) finish({ ok: false, code: "memory" });
                });
            }, RSS_POLL_MS);
            child.once("exit", () => finish({ ok: false, code: "crashed" }));
            child.once("error", () => finish({ ok: false, code: "crashed" }));
            child.on("message", (message: { type?: string; outcome?: PythonRunOutcome }) => {
                if (message?.type === "done" && message.outcome) finish(message.outcome);
            });
            child.send({ type: "run", code: req.code, docs: req.docs, limits: { stdoutChars, resultBytes, maxOutputs } }, (error) => {
                if (error) finish({ ok: false, code: "crashed" });
            });
        });
    }

    shutdown() {
        if (this.warmTimer) clearTimeout(this.warmTimer);
        this.warm?.process.kill("SIGKILL");
        this.warm = null;
    }
}
