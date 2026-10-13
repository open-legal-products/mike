import { randomUUID } from "node:crypto";
import { fork, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { DbJob } from "../../lib/dbq/types";

// Real processes + real Postgres/PostgREST + real BullMQ. Run against disposable
// services only; batch claims are global, so stack suites run serially by file.
const url = process.env.SUPABASE_TEST_URL;
const key = process.env.SUPABASE_TEST_SERVICE_ROLE_KEY;
const redisUrl = process.env.DB_JOB_TEST_REDIS_URL;
const suite = url && key && redisUrl ? describe : describe.skip;
type Event = { event: string; request?: number; message?: string; id?: string; attempts?: number; renewable?: boolean };

class Fixture {
    readonly child: ChildProcess;
    readonly events: Event[] = [];
    readonly exit: Promise<void>;
    output = "";
    private sequence = 0;
    /** Spawn a credential-isolated child and retain IPC/output for deterministic test barriers. */
    constructor(config: Record<string, unknown>) {
        this.child = fork(resolve("src/__tests__/fixtures/dbJobWorker.ts"), [JSON.stringify(config)], {
            execArgv: ["--import", "tsx"],
            env: {
                // Do not propagate developer/provider credentials into a fixture.
                PATH: process.env.PATH, NODE_ENV: "test", SENTRY_DISABLED: "true",
                SUPABASE_TEST_URL: url, SUPABASE_TEST_SERVICE_ROLE_KEY: key,
                SUPABASE_URL: url, SUPABASE_SECRET_KEY: key,
                REDIS_URL: redisUrl, QUEUE_DRIVER: "redis", DB_JOBS_POLL_MS: "250",
            },
            stdio: ["ignore", "pipe", "pipe", "ipc"],
        });
        this.child.stdout?.on("data", (chunk) => { this.output += String(chunk); });
        this.child.stderr?.on("data", (chunk) => { this.output += String(chunk); });
        this.child.on("message", (message) => this.events.push(message as Event));
        this.exit = new Promise((resolveExit) => this.child.once("exit", () => resolveExit()));
    }
    /** Await a matching child event and fail promptly if the process exits first. */
    async wait(event: string, predicate: (value: Event) => boolean = () => true): Promise<Event> {
        let found: Event | undefined;
        await until(() => {
            found = this.events.find((value) => value.event === event && predicate(value));
            if (!found && (this.child.exitCode !== null || this.child.signalCode !== null)) throw new Error(`fixture exited: ${this.output}`);
            return !!found;
        });
        return found!;
    }
    /** Correlate an IPC command with its reply while observing early rejection on cleanup. */
    command(command: string, values: Record<string, unknown> = {}): Promise<void> {
        const pending = (async () => {
            const request = ++this.sequence;
            this.child.send({ command, request, ...values });
            let reply: Event | undefined;
            await until(() => {
                reply = this.events.find((event) => event.request === request && ["reply", "error"].includes(event.event));
                if (!reply && (this.child.exitCode !== null || this.child.signalCode !== null)) throw new Error(`fixture exited: ${this.output}`);
                return !!reply;
            });
            if (reply?.event === "error") throw new Error(reply.message);
        })();
        // A failed assertion may kill the child before its held command replies.
        // Observe that rejection now while still returning it to the caller.
        void pending.catch(() => {});
        return pending;
    }
    /** Kill only this fixture process and await exit before deleting its database rows. */
    async kill(): Promise<void> {
        if (this.child.exitCode !== null || this.child.signalCode !== null) return;
        this.child.kill("SIGKILL");
        await this.exit;
    }
}

/** Poll a real-service barrier with a finite timeout instead of assuming a fixed delay suffices. */
async function until(predicate: () => boolean | Promise<boolean>, timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(await predicate())) {
        if (Date.now() >= deadline) throw new Error("worker proof barrier timed out");
        await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }
}

suite("db_jobs real worker processes", () => {
    let db: SupabaseClient;
    const children: Fixture[] = [];
    const ids: string[] = [];
    /** Age a fictional timestamp beyond the production lease window without a ten-minute sleep. */
    const stale = () => new Date(Date.now() - 660_000).toISOString();
    beforeAll(() => { db = createClient(url!, key!, { auth: { persistSession: false, autoRefreshToken: false } }); });
    afterEach(async () => {
        await Promise.all(children.splice(0).map((child) => child.kill()));
        if (ids.length) {
            const { error } = await db.from("db_jobs").delete().in("id", ids.splice(0));
            if (error) throw error;
        }
    });
    /** Track a child for teardown and wait until its production modules are loaded. */
    async function child(config: Record<string, unknown>): Promise<Fixture> {
        const instance = new Fixture(config); children.push(instance);
        await instance.wait("ready"); return instance;
    }
    /** Insert a fictional queue row and retain its ID for scoped teardown. */
    async function insert(kind: string, fields: Record<string, unknown> = {}): Promise<DbJob> {
        const { data, error } = await db.from("db_jobs").insert({ kind, payload: {}, ...fields }).select("*").single();
        if (error) throw error;
        ids.push(data.id); return data as DbJob;
    }
    /** Read authoritative persisted job state after a process or transport barrier. */
    async function row(id: string): Promise<DbJob> {
        const { data, error } = await db.from("db_jobs").select("*").eq("id", id).single();
        if (error) throw error;
        return data as DbJob;
    }
    /** Set explicit test preconditions, including aged lease timestamps, through real PostgREST. */
    async function update(id: string, fields: Record<string, unknown>): Promise<void> {
        const { error } = await db.from("db_jobs").update(fields).eq("id", id);
        if (error) throw error;
    }

    it("keeps an old claim live with real renewal, then recovers after SIGKILL and heartbeat expiry", async () => {
        const kind = `worker.test.${randomUUID()}`;
        // Age only the immutable original claim; heartbeat is currently valid.
        // This exercises the production 600s predicate without a ten-minute sleep.
        const job = await insert(kind, { status: "running", attempts: 1, claimed_at: stale(), heartbeat_at: new Date().toISOString() });
        const first = await child({ kind, renewable: true, hold: true });
        const running = first.command("process", { job }).catch(() => {});
        await first.wait("body");
        const initialHeartbeat = (await row(job.id)).heartbeat_at;
        await until(async () => (await row(job.id)).heartbeat_at !== initialHeartbeat);
        const live = await row(job.id);
        expect(live.claimed_at).toBe(job.claimed_at);
        expect(live.attempts).toBe(1);
        const second = await child({ kind, renewable: true });
        await second.command("poll");
        expect(second.events.filter((event) => event.event === "body")).toHaveLength(0);
        await first.kill();
        // A killed process never replies to its pending IPC request.
        await running;
        await update(job.id, { heartbeat_at: stale() });
        await second.command("poll");
        expect(second.events.filter((event) => event.event === "body")).toHaveLength(1);
        expect(await row(job.id)).toMatchObject({ status: "done", attempts: 2, result: { fixture: true } });
    }, 30_000);

    it.each(["success", "terminal", "retry"] as const)("suppresses stale %s settlement, hooks and retry delivery after another process reclaims", async (outcome) => {
        const kind = `worker.test.${randomUUID()}`;
        const job = await insert(kind);
        const first = await child({ kind, hold: true, fail: outcome === "success" ? undefined : outcome });
        const running = first.command("poll");
        await first.wait("body");
        await update(job.id, { heartbeat_at: stale() });
        const second = await child({ kind, hold: true });
        const replacement = second.command("poll");
        await second.wait("body");
        const replacementClaim = await row(job.id);
        expect(replacementClaim.attempts).toBe(2);
        await first.command("release"); await running;
        expect(first.events.some((event) => event.event === "hook")).toBe(false);
        const connection = new IORedis(redisUrl!, { maxRetriesPerRequest: null });
        const queue = new Queue("app-jobs", { connection });
        try { expect(await queue.getJob(`dbjob_${job.id}_1`)).toBeUndefined(); }
        finally { await queue.close(); await connection.quit(); }
        expect(await row(job.id)).toMatchObject({ status: "running", attempts: 2, claimed_at: replacementClaim.claimed_at });
        await second.command("release"); await replacement;
        expect((await row(job.id)).status).toBe("done");
    }, 30_000);

    it("lets only one owner execute when actual Redis delivery races a poll process", async () => {
        const kind = `worker.test.${randomUUID()}`;
        const poller = await child({ kind, renewable: true, hold: true });
        const receiver = await child({ kind, renewable: true, hold: true });
        await receiver.command("redis");
        const connection = new IORedis(redisUrl!, { maxRetriesPerRequest: null });
        const queue = new Queue("app-jobs", { connection });
        try {
            const job = await insert(kind);
            const polled = poller.command("poll");
            await queue.add("deliver", { dbJobId: job.id }, { jobId: `proof_${job.id}`, attempts: 1, removeOnComplete: true, removeOnFail: true });
            await until(() => [poller, receiver].some((worker) => worker.events.some((event) => event.event === "body")));
            // Wait for the losing transport, rather than assuming a timing delay
            // proves it tried. Redis removes its no-op delivery on completion.
            if (poller.events.some((event) => event.event === "body")) {
                await until(async () => !(await queue.getJob(`proof_${job.id}`)));
            } else {
                await polled;
            }
            expect([...poller.events, ...receiver.events].filter((event) => event.event === "body")).toHaveLength(1);
            expect((await row(job.id)).attempts).toBe(1);
            await Promise.all([poller.command("release"), receiver.command("release")]);
            await polled;
            await until(async () => (await row(job.id)).status === "done");
            await receiver.command("close"); await receiver.exit;
            expect([...poller.events, ...receiver.events].filter((event) => event.event === "body")).toHaveLength(1);
        } finally { await queue.close(); await connection.quit(); }
    }, 30_000);

    it("uses the renewable policy through the actual Redis worker", async () => {
        const kind = `worker.test.${randomUUID()}`;
        const receiver = await child({ kind, renewable: true, hold: true });
        await receiver.command("redis");
        const connection = new IORedis(redisUrl!, { maxRetriesPerRequest: null });
        const queue = new Queue("app-jobs", { connection });
        try {
            const job = await insert(kind);
            await queue.add("deliver", { dbJobId: job.id }, { jobId: `proof_${job.id}`, attempts: 1, removeOnComplete: true, removeOnFail: true });
            expect((await receiver.wait("body")).renewable).toBe(true);
            const initial = await row(job.id);
            await until(async () => (await row(job.id)).heartbeat_at !== initial.heartbeat_at);
            expect((await row(job.id)).claimed_at).toBe(initial.claimed_at);
            await receiver.command("release");
            await until(async () => (await row(job.id)).status === "done");
            await receiver.command("close"); await receiver.exit;
        } finally { await queue.close(); await connection.quit(); }
    }, 30_000);

    it("recovers a row with no Redis delivery through the production poll loop", async () => {
        const kind = `worker.test.${randomUUID()}`;
        const job = await insert(kind);
        const poller = await child({ kind, renewable: true });
        await poller.command("start");
        await poller.wait("body");
        await until(async () => (await row(job.id)).status === "done");
        await poller.command("stop-runner");
        expect((await row(job.id)).attempts).toBe(1);
    }, 30_000);

    it("stops before the initial timer without a claim, and a deliberate restart runs it", async () => {
        const kind = `worker.test.${randomUUID()}`;
        const job = await insert(kind);
        const poller = await child({ kind });
        await poller.command("start-stop");
        await new Promise((resolveWait) => setTimeout(resolveWait, 1_200));
        expect((await row(job.id)).status).toBe("pending");
        expect(poller.events.some((event) => event.event === "body")).toBe(false);
        await poller.command("start");
        await until(async () => (await row(job.id)).status === "done");
        await poller.command("stop-runner");
        expect(poller.events.filter((event) => event.event === "body")).toHaveLength(1);
    }, 30_000);

    it.each(["poll", "delivery"])("starts no body after stop when a real %s claim response arrives late", async (command) => {
        const kind = `worker.test.${randomUUID()}`;
        const job = await insert(kind);
        const worker = await child({ kind, renewable: true, holdClaimResponse: true });
        const running = worker.command(command, { id: job.id });
        await worker.wait("claim_committed");
        expect((await row(job.id)).status).toBe("running");
        await worker.command("stop-intake"); await worker.command("release-claim"); await running;
        expect(worker.events.some((event) => event.event === "body")).toBe(false);
        expect((await row(job.id)).status).toBe("running");
        await update(job.id, { heartbeat_at: stale() });
        const replacement = await child({ kind, renewable: true });
        await replacement.command("poll");
        expect(await row(job.id)).toMatchObject({ status: "done", attempts: 2 });
    }, 30_000);
});
