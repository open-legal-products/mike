import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Stack-level test for the DB queue's claim SQL. These are properties of the
// Postgres functions themselves — FOR UPDATE SKIP LOCKED partitioning, stale
// reclaim, and the attempt budget applying to a job that crashed its worker —
// so a mock proves nothing. Gated exactly like stack.supabase.test.ts: run a
// local stack, then export
//   SUPABASE_TEST_URL, SUPABASE_TEST_SERVICE_ROLE_KEY, SUPABASE_TEST_ANON_KEY
const url = process.env.SUPABASE_TEST_URL;
const serviceKey = process.env.SUPABASE_TEST_SERVICE_ROLE_KEY;
const maybeDescribe = url && serviceKey ? describe : describe.skip;

/** Stale threshold used by the calls below (seconds). */
const STALE = 600;
const STALE_AGO = new Date(Date.now() - (STALE + 60) * 1000).toISOString();

maybeDescribe("db_jobs claim SQL", () => {
    let db: SupabaseClient;
    const created: string[] = [];

    /** Create a fictional queue row and register its ID for teardown. */
    const insertJob = async (row: Record<string, unknown>) => {
        const { data, error } = await db
            .from("db_jobs")
            .insert({ kind: "stack.test", payload: {}, ...row })
            .select("*")
            .single();
        if (error) throw new Error(error.message);
        created.push(data.id as string);
        return data as Record<string, unknown>;
    };

    /** Exercise the production batch claim RPC with a test-kind filter. */
    const claimBatch = async (limit = 10) => {
        const { data, error } = await db.rpc("claim_db_jobs", {
            p_limit: limit,
            p_stale_seconds: STALE,
            p_kind: "stack.test",
        });
        if (error) throw new Error(error.message);
        return (data ?? []) as Record<string, unknown>[];
    };

    /** Read persisted state independently of the claim or settlement response. */
    const reload = async (id: string) => {
        const { data, error } = await db
            .from("db_jobs")
            .select("*")
            .eq("id", id)
            .single();
        if (error) throw new Error(error.message);
        return data as Record<string, unknown>;
    };

    beforeAll(() => {
        db = createClient(url!, serviceKey!, {
            auth: { persistSession: false, autoRefreshToken: false },
        });
    });

    afterAll(async () => {
        if (created.length)
            await db.from("db_jobs").delete().in("id", created);
    });

    it("claims a due pending job, incrementing attempts and stamping claimed_at", async () => {
        const job = await insertJob({ dedupe_key: `claim-${Date.now()}` });
        const claimed = await claimBatch();
        const mine = claimed.find((j) => j.id === job.id);
        expect(mine).toBeTruthy();
        expect(mine!.status).toBe("running");
        expect(mine!.attempts).toBe(1);
        expect(mine!.claimed_at).not.toBeNull();
        expect(mine!.heartbeat_at).toBe(mine!.claimed_at);
        // A second claim does not double-claim it: it is running and fresh.
        const again = await claimBatch();
        expect(again.some((j) => j.id === job.id)).toBe(false);
    });

    it("reclaims a stale running job while attempts remain", async () => {
        const job = await insertJob({
            status: "running",
            claimed_at: STALE_AGO,
            attempts: 1,
            max_attempts: 3,
        });
        const claimed = await claimBatch();
        const mine = claimed.find((j) => j.id === job.id);
        expect(mine).toBeTruthy();
        expect(mine!.attempts).toBe(2);
    });

    // The crash-loop the guard exists to stop: a job that kills its worker
    // never reaches the runner's retry state machine, so before the guard it
    // was reclaimed every stale window forever, taking a worker each time.
    it("does NOT reclaim a stale running job whose attempts are spent", async () => {
        const job = await insertJob({
            status: "running",
            claimed_at: STALE_AGO,
            attempts: 3,
            max_attempts: 3,
        });
        const claimed = await claimBatch();
        expect(claimed.some((j) => j.id === job.id)).toBe(false);
    });

    it("terminally fails an over-budget stale running job", async () => {
        const job = await insertJob({
            status: "running",
            claimed_at: STALE_AGO,
            attempts: 5,
            max_attempts: 5,
        });
        await claimBatch();
        const after = await reload(job.id as string);
        expect(after.status).toBe("failed");
        expect(after.finished_at).not.toBeNull();
        expect(String(after.last_error)).toMatch(/abandoned/);
    });

    it("claim_db_job (single id) applies the same attempt budget", async () => {
        const spent = await insertJob({
            status: "running",
            claimed_at: STALE_AGO,
            attempts: 2,
            max_attempts: 2,
        });
        const live = await insertJob({
            status: "running",
            claimed_at: STALE_AGO,
            attempts: 1,
            max_attempts: 2,
        });

        const spentClaim = await db.rpc("claim_db_job", {
            p_id: spent.id,
            p_stale_seconds: STALE,
        });
        expect(spentClaim.error).toBeNull();
        expect((spentClaim.data ?? []).length).toBe(0);

        const liveClaim = await db.rpc("claim_db_job", {
            p_id: live.id,
            p_stale_seconds: STALE,
        });
        expect(liveClaim.error).toBeNull();
        expect((liveClaim.data ?? []).length).toBe(1);
    });

    // The fencing token the runner writes with. A reclaim moves both values,
    // so the zombie predecessor's terminal write matches nothing.
    it("a reclaim moves the fencing token, so the old claim matches no rows", async () => {
        const job = await insertJob({
            status: "running",
            claimed_at: STALE_AGO,
            attempts: 1,
            max_attempts: 3,
        });
        const [reclaimed] = (await claimBatch()).filter(
            (j) => j.id === job.id,
        );
        expect(reclaimed).toBeTruthy();

        // The zombie finalizes using the token it was handed at ITS claim.
        const zombie = await db
            .from("db_jobs")
            .update({ status: "done", finished_at: new Date().toISOString() })
            .eq("id", job.id)
            .eq("status", "running")
            .eq("attempts", job.attempts)
            .eq("claimed_at", job.claimed_at)
            .select("id");
        expect(zombie.error).toBeNull();
        expect(zombie.data ?? []).toHaveLength(0);

        // The current claimant's write, with the current token, does land.
        const winner = await db
            .from("db_jobs")
            .update({ status: "done", finished_at: new Date().toISOString() })
            .eq("id", job.id)
            .eq("status", "running")
            .eq("attempts", reclaimed.attempts)
            .eq("claimed_at", reclaimed.claimed_at)
            .select("id");
        expect(winner.data ?? []).toHaveLength(1);
    });
    const heartbeat = (job: Record<string, unknown>) => db.rpc("heartbeat_db_job", {
        p_id: job.id, p_attempts: job.attempts, p_claimed_at: job.claimed_at,
    });
    const settle = (job: Record<string, unknown>, overrides = {}) => db.rpc("settle_live_db_job", {
        p_id: job.id, p_attempts: job.attempts, p_claimed_at: job.claimed_at,
        p_outcome: "done", p_result: { fixture: true }, p_last_error: null,
        p_run_at: null, p_refund_attempt: false, ...overrides,
    });
    const freshClaim = () => insertJob({ status: "running", attempts: 1,
        claimed_at: new Date().toISOString(), heartbeat_at: null });

    it("renewal changes only heartbeat and fences wrong attempts/timestamps/status", async () => {
        const job = await freshClaim();
        const renewal = await heartbeat(job);
        expect(renewal.error).toBeNull();
        expect(renewal.data).toHaveLength(1);
        const after = await reload(job.id as string);
        expect(after.claimed_at).toBe(job.claimed_at);
        expect(after.attempts).toBe(job.attempts);
        expect(after.heartbeat_at).not.toBeNull();
        for (const token of [{ ...job, attempts: 2 }, { ...job, claimed_at: STALE_AGO }]) {
            const rejected = await heartbeat(token);
            expect(rejected.error).toBeNull();
            expect(rejected.data).toEqual([]);
        }
        expect((await settle(job)).data).toHaveLength(1);
        expect((await heartbeat(job)).data).toEqual([]);
        expect((await settle(job)).data).toEqual([]);
    });

    it("expired but unreclaimed claims cannot renew or settle", async () => {
        for (const heartbeat_at of [null, STALE_AGO]) {
            const job = await insertJob({ status: "running", attempts: 1,
                claimed_at: STALE_AGO, heartbeat_at });
            expect((await heartbeat(job)).data).toEqual([]);
            expect((await settle(job)).data).toEqual([]);
            expect((await reload(job.id as string)).status).toBe("running");
        }
    });

    it("fresh heartbeat protects an old claim from BOTH claim paths and abandoned sweep", async () => {
        const job = await insertJob({ status: "running", attempts: 5, max_attempts: 5,
            claimed_at: STALE_AGO, heartbeat_at: new Date().toISOString() });
        expect((await db.rpc("claim_db_job", { p_id: job.id })).data).toEqual([]);
        await claimBatch();
        expect((await reload(job.id as string)).status).toBe("running");
    });

    it("single-ID claim stamps heartbeat equal to the immutable claim time", async () => {
        const job = await insertJob({});
        const { data, error } = await db.rpc("claim_db_job", { p_id: job.id });
        expect(error).toBeNull();
        expect(data).toHaveLength(1);
        expect(data[0].heartbeat_at).toBe(data[0].claimed_at);
    });

    it("live settlement preserves claim identity and refunds exactly once", async () => {
        const job = await freshClaim();
        const patch = { p_outcome: "pending", p_run_at: new Date(Date.now() + 60000).toISOString(), p_refund_attempt: true };
        expect((await settle(job, patch)).data).toHaveLength(1);
        expect((await settle(job, patch)).data).toEqual([]);
        const after = await reload(job.id as string);
        expect(after.attempts).toBe(0);
        expect(after.finished_at).toBeNull();
        expect(after.claimed_at).toBe(job.claimed_at);
        expect(after.heartbeat_at).toBe(job.heartbeat_at);
        expect(after.max_attempts).toBe(job.max_attempts);
    });

    it("rejects malformed settlements without changing the claim", async () => {
        const job = await freshClaim();
        for (const patch of [{ p_outcome: "running" }, { p_outcome: null },
            { p_outcome: "pending" }, { p_refund_attempt: true },
            { p_outcome: "pending", p_run_at: "infinity" }]) {
            expect((await settle(job, patch)).error?.code).toBe("22023");
        }
        expect((await reload(job.id as string)).status).toBe("running");
    });

    it("kind-filtered batch still globally abandons ordinary exhausted rows", async () => {
        const spent = await insertJob({ status: "running", claimed_at: STALE_AGO,
            attempts: 5, max_attempts: 5 });
        const { error } = await db.rpc("claim_db_jobs", { p_limit: 1, p_kind: "nonexistent.test" });
        expect(error).toBeNull();
        expect((await reload(spent.id as string)).status).toBe("failed");
    });

    it.each(["storage.cleanup", "document.cleanup"])("preserves %s revival, saturation and bounded backoff", async (kind) => {
        const job = await insertJob({ kind, status: "failed", attempts: 2147483647,
            max_attempts: 5, dedupe_key: `cleanup-${kind}-${Date.now()}` });
        const { data, error } = await db.rpc("claim_db_job", { p_id: job.id });
        expect(error).toBeNull();
        expect(data).toHaveLength(1);
        expect(data[0].attempts).toBe(2147483647);
        expect(data[0].max_attempts).toBe(2147483647);
        expect(data[0].dedupe_key).toBeNull();
        expect(new Date(data[0].run_at).getTime() - new Date(data[0].claimed_at).getTime()).toBe(600000);
        expect(data[0].heartbeat_at).toBe(data[0].claimed_at);
        // An old runner rejecting the kind cannot revive it in a hot loop.
        await db.from("db_jobs").update({ status: "failed" }).eq("id", job.id);
        expect((await db.rpc("claim_db_job", { p_id: job.id })).data).toEqual([]);
    });

    it("does not claim future pending jobs", async () => {
        const job = await insertJob({ run_at: new Date(Date.now() + 3600000).toISOString() });
        expect((await db.rpc("claim_db_job", { p_id: job.id })).data).toEqual([]);
        expect((await claimBatch()).some((row) => row.id === job.id)).toBe(false);
    });

});


// Direct SQL is required for a deterministic row-lock barrier. The PostgREST
// calls under test still use the actual service-role client, not a SQL mock.
const databaseUrl = process.env.SUPABASE_TEST_DB_URL;
const sqlDescribe = url && serviceKey && databaseUrl ? describe : describe.skip;
sqlDescribe("db_jobs locked lease and privilege SQL", () => {
    const exec = promisify(execFile);
    const sql = async (query: string) => (await exec("psql", [databaseUrl!, "-XAtq",
        "-v", "ON_ERROR_STOP=1", "-c", query], { timeout: 15000 })).stdout.trim();

    it.each(["heartbeat_db_job", "settle_live_db_job"])("%s checks expiry after waiting for the row lock", async (rpc) => {
        const id = await sql(`insert into public.db_jobs(kind,status,attempts,claimed_at)
            values('stack.lock.test','running',1,clock_timestamp()) returning id`);
        const child = spawn("psql", [databaseUrl!, "-XAtq", "-v", "ON_ERROR_STOP=1"],
            { stdio: ["pipe", "pipe", "pipe"] });
        let output = "";
        let stderr = "";
        child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
        const closed = new Promise<void>((resolve, reject) => {
            child.on("error", reject);
            child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`lock fixture exited ${code}: ${stderr}`)));
        });
        // Keep the rejection observed even if setup fails before awaiting it.
        void closed.catch(() => undefined);
        try {
            const locked = new Promise<void>((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error("lock barrier timeout")), 5000);
                child.stdout.on("data", (chunk) => {
                    output += chunk.toString();
                    if (output.includes("locked")) { clearTimeout(timer); resolve(); }
                });
            });
            child.stdin.write(`begin; select id from public.db_jobs where id='${id}' for update; select 'locked';\n`);
            await locked;
            const db = createClient(url!, serviceKey!, { auth: { persistSession: false } });
            const token = await sql(`select claimed_at from public.db_jobs where id='${id}'`);
            const args = { p_id: id, p_attempts: 1, p_claimed_at: token };
            const pending = Promise.resolve(db.rpc(rpc, rpc === "heartbeat_db_job" ? args : {
                ...args, p_outcome: "done", p_result: null, p_last_error: null,
                p_run_at: null, p_refund_attempt: false,
            }));
            // Confirm the real RPC is waiting, then move the stored heartbeat
            // across expiry inside the lock. This avoids ten-minute sleeps and
            // fails implementations which capture wall time before locking.
            let waiting = false;
            for (let attempt = 0; attempt < 50; attempt++) {
                waiting = (await sql(`select exists(select 1 from pg_stat_activity
                    where wait_event_type='Lock' and query like '%${rpc}%')`)) === "t";
                if (waiting) break;
                await new Promise((resolve) => setTimeout(resolve, 20));
            }
            expect(waiting).toBe(true);
            child.stdin.end(`update public.db_jobs set heartbeat_at=clock_timestamp()-interval '600 seconds' where id='${id}'; commit;\n`);
            await closed;
            const result = await pending;
            expect(result.error).toBeNull();
            expect(result.data).toEqual([]);
            expect(await sql(`select status from public.db_jobs where id='${id}'`)).toBe("running");
        } finally {
            if (child.exitCode === null) child.kill("SIGKILL");
            await closed.catch(() => undefined);
            await sql(`delete from public.db_jobs where id='${id}'`);
        }
    }, 20000);

    it("restricts all claim/lease RPCs to service_role and uses invoker security", async () => {
        const names = "'claim_db_jobs','claim_db_job','heartbeat_db_job','settle_live_db_job'";
        expect(await sql(`select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
            where n.nspname='public' and p.proname in (${names})`)).toBe("4");
        expect(await sql(`select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
            where n.nspname='public' and p.proname in (${names}) and
            (has_function_privilege('anon',p.oid,'EXECUTE') or
             has_function_privilege('authenticated',p.oid,'EXECUTE') or
             not has_function_privilege('service_role',p.oid,'EXECUTE') or p.prosecdef)`)).toBe("0");
        expect(await sql(`select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
            where n.nspname='public' and p.proname in (${names}) and p.proconfig @> array['search_path=""']`)).toBe("4");
    });

    it("can use the partial heartbeat index for stale running claims", async () => {
        // Transaction rollback leaves no workload data; enough representative
        // rows make this an actual planner choice, not enable_seqscan=off.
        const plan = await sql(`begin;
            insert into public.db_jobs(kind,status,claimed_at,heartbeat_at)
            select 'stack.index.test',case when n%2=0 then 'done' else 'running' end,
                clock_timestamp(),case when n=1 then clock_timestamp()-interval '601 seconds' else clock_timestamp() end
            from generate_series(1,10000) n;
            analyze public.db_jobs;
            explain (format json) select id from public.db_jobs where status='running'
              and coalesce(heartbeat_at,claimed_at)<now()-interval '600 seconds';
            rollback;`);
        expect(plan).toContain("db_jobs_running_heartbeat_idx");
    });
});
