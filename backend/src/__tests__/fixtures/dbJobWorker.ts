/** Isolated child-process harness. Never imported by production startup. */
import { createClient } from "@supabase/supabase-js";
import {
    NonRetryableJobError, processClaimedJob, runDbJobTick,
    startDbJobRunner, stopDbJobIntake, stopDbJobRunner,
} from "../../lib/dbq/runner";
import { createAppJobsWorker, runAppJobDelivery, stopAppJobsWorker } from "../../workers/appJobsWorker";
import { DB_JOB_HANDLERS, DB_JOB_FAILURE_HOOKS, DB_JOB_EXECUTION_POLICIES } from "../../jobs/registry";
import { closeRedisConnection } from "../../lib/queue/connection";
import { closeAppJobsQueue } from "../../lib/queue/appJobsQueue";
import type { DbJob, DbJobExecutionContext } from "../../lib/dbq/types";

type Config = { kind: string; hold?: boolean; fail?: "terminal" | "retry"; renewable?: boolean; holdClaimResponse?: boolean };
const config = JSON.parse(process.argv[2]!) as Config;
const send = (event: string, value: Record<string, unknown> = {}) => process.send?.({ event, ...value });
let releaseBody: (() => void) | undefined;
const bodyBarrier = new Promise<void>((resolve) => { releaseBody = resolve; });
let releaseClaim: (() => void) | undefined;
const claimBarrier = new Promise<void>((resolve) => { releaseClaim = resolve; });
const shutdown = new AbortController();
const nativeFetch = globalThis.fetch;
const db = createClient(process.env.SUPABASE_TEST_URL!, process.env.SUPABASE_TEST_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: async (input, init) => {
        const response = await nativeFetch(input, init);
        // The real RPC has committed. Hold only its response, never fake SQL.
        if (config.holdClaimResponse && String(input).includes("/rpc/claim_db_job")) {
            send("claim_committed");
            await claimBarrier;
        }
        return response;
    } },
});
const handlers = {
    [config.kind]: async (_db: typeof db, job: DbJob, context?: DbJobExecutionContext) => {
        send("body", { id: job.id, attempts: job.attempts, renewable: !!context });
        if (config.hold) await bodyBarrier;
        if (config.fail === "terminal") throw new NonRetryableJobError("synthetic_worker_failure");
        if (config.fail === "retry") throw new Error("synthetic_worker_retry");
        return { fixture: true };
    },
};
const hooks = { [config.kind]: async () => { send("hook"); } };
const policies = config.renewable
    ? { [config.kind]: { heartbeatIntervalMs: 100, maxDurationMs: 30_000 } }
    : {};
// Only this disposable process registers a synthetic kind. Production stays empty.
Object.assign(DB_JOB_HANDLERS, handlers);
Object.assign(DB_JOB_FAILURE_HOOKS, hooks);
Object.assign(DB_JOB_EXECUTION_POLICIES, policies);

process.on("message", (raw) => {
    const message = raw as { command: string; request: number; job?: DbJob; id?: string };
    void (async () => {
        switch (message.command) {
            case "poll": await runDbJobTick(db, handlers, hooks, undefined, { policies, signal: shutdown.signal }); break;
            case "delivery": await runAppJobDelivery({ dbJobId: message.id! }, db, shutdown.signal); break;
            case "process": await processClaimedJob(db, handlers, message.job!, hooks, { policies, signal: shutdown.signal }); break;
            case "redis": await createAppJobsWorker().waitUntilReady(); break;
            case "start": startDbJobRunner(handlers, hooks, policies); break;
            case "start-stop":
                startDbJobRunner(handlers, hooks, policies); stopDbJobIntake();
                await stopDbJobRunner(); break;
            case "stop-intake": shutdown.abort(); stopDbJobIntake(); break;
            case "stop-runner": await stopDbJobRunner(); break;
            case "release": releaseBody?.(); break;
            case "release-claim": releaseClaim?.(); break;
            case "close":
                shutdown.abort(); stopDbJobIntake(); releaseBody?.(); releaseClaim?.();
                await stopDbJobRunner(); await stopAppJobsWorker();
                await closeAppJobsQueue(); await closeRedisConnection();
                send("reply", { request: message.request });
                process.disconnect?.();
                return;
            default: throw new Error("unknown_fixture_command");
        }
        send("reply", { request: message.request });
    })().catch((error: unknown) => {
        send("error", { request: message.request, message: error instanceof Error ? error.message : "fixture_error" });
    });
});
send("ready");
