// Regression tests for the FAIL-CLOSED contract of scripts/audit-gate.mjs.
//
// Run: node --test scripts/audit-gate.test.mjs
//
// The gate's only job is to refuse. Every bug it has had was the same bug —
// some path where "we could not check" printed the same "audit gate passed"
// as "we checked and it is clean" — so these tests assert the exit code for
// the ways that has happened, not the advisory parsing.

import { deepStrictEqual, notStrictEqual, strictEqual } from "node:assert";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const gatePath = join(dirname(fileURLToPath(import.meta.url)), "audit-gate.mjs");

const NPM_BULK_PATH = "/-/npm/v1/security/advisories/bulk";
/** The canary the gate smuggles into every npm batch. */
const CANARY_ADVISORY = {
    id: 1123686,
    url: "https://github.com/advisories/GHSA-xcpc-8h2w-3j85",
    title: "adm-zip: Crafted ZIP file triggers 4GB memory allocation",
    severity: "high",
};

/**
 * One stub standing in for BOTH advisory services; each test installs the
 * responses it needs. `requests` records (url, body) so a test can prove what
 * the gate did and did not consult.
 */
const requests = [];
// Declared with the (url, body) arity every test's override uses, so the
// call site below is not a "superfluous argument" to a zero-arity default.
let respond = (_url, _body) => ({ status: 200, body: { error: "nope" } });

const stub = createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
        let parsed = null;
        try {
            parsed = raw ? JSON.parse(raw) : null;
        } catch {
            parsed = null;
        }
        requests.push({ url: req.url, body: parsed });
        const { status = 200, body } = respond(req.url, parsed) ?? {};
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body ?? {}));
    });
});
await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
const stubUrl = `http://127.0.0.1:${stub.address().port}`;
after(() => stub.close());

// spawn, never spawnSync: the stub registry runs on THIS process's event
// loop, and a synchronous child would block it — the child's requests would
// go unanswered until they timed out, turning a 0.2s test into a 100s one.
function runGate(lockfile, { workspace = "fixture", allowlist } = {}) {
    const repo = mkdtempSync(join(tmpdir(), "audit-gate-"));
    const scripts = join(repo, "scripts");
    const dir = join(repo, workspace);
    mkdirSync(scripts);
    mkdirSync(dir, { recursive: true });
    for (const name of ["audit-gate.mjs", "audit-allowlist.json"]) {
        copyFileSync(join(dirname(gatePath), name), join(scripts, name));
    }
    if (allowlist) writeFileSync(join(scripts, "audit-allowlist.json"), JSON.stringify(allowlist));
    writeFileSync(join(dir, "package-lock.json"), JSON.stringify(lockfile));
    const child = spawn(process.execPath, [join(scripts, "audit-gate.mjs")], {
        cwd: dir,
        env: {
            ...process.env,
            npm_config_registry: stubUrl,
            OSV_API_BASE_URL: stubUrl,
        },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (c) => (stdout += c));
    child.stderr.setEncoding("utf8").on("data", (c) => (stderr += c));
    return new Promise((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (status) => {
            rmSync(repo, { recursive: true, force: true });
            resolve({ status, stdout, stderr });
        });
    });
}

const LOCKFILE_WITH_PACKAGES = {
    lockfileVersion: 3,
    packages: {
        "": { name: "fixture", version: "1.0.0" },
        "node_modules/left-pad": { version: "1.3.0" },
    },
};

test("fails when the advisory services answer 200 with an error payload", async () => {
    // Both services are the stub, so npm fails validation and the OSV fallback
    // fails too. Passing here would mean shipping unaudited dependencies every
    // time a proxy or a captive network sat in front of the registry.
    requests.length = 0;
    respond = () => ({ status: 200, body: { error: "nope" } });
    const result = await runGate(LOCKFILE_WITH_PACKAGES);
    notStrictEqual(result.status, 0, `expected non-zero exit\n${result.stderr}`);
    strictEqual(result.stdout.includes("audit gate passed"), false);
});

test("fails when the lockfile declares no packages, without calling out", async () => {
    // An npm 6 lockfile (or a truncated one) yields zero queries, so every loop
    // in the gate is skipped and it used to report a clean audit having made no
    // network call at all.
    requests.length = 0;
    respond = () => ({ status: 200, body: {} });
    const result = await runGate({ lockfileVersion: 1, dependencies: {} });
    notStrictEqual(result.status, 0, `expected non-zero exit\n${result.stderr}`);
    strictEqual(result.stdout.includes("audit gate passed"), false);
    strictEqual(result.stderr.includes("no resolved packages"), true);
    // Nothing was consulted — which is exactly why it must not pass.
    deepStrictEqual(requests, []);
});

// THE `{}` PROBLEM. An empty object is npm's legitimate answer for a clean
// tree, so no shape check can separate it from an endpoint that does not
// implement the route (a proxy, a mirror, the endpoint's retirement). The
// canary is what separates them: the gate asks about a package it KNOWS is
// vulnerable, and silence about that package is silence about everything.
test("treats an empty npm answer as unsupported and falls through to OSV", async () => {
    requests.length = 0;
    respond = (url) => {
        if (url === NPM_BULK_PATH) return { status: 200, body: {} };
        if (url === "/querybatch")
            // One query: the fixture has one package at one version.
            return { status: 200, body: { results: [{}] } };
        return { status: 200, body: {} };
    };

    const result = await runGate(LOCKFILE_WITH_PACKAGES);

    strictEqual(result.status, 0, `expected a pass via OSV\n${result.stderr}`);
    strictEqual(result.stdout.includes("audit gate passed"), true);
    // It did not believe npm...
    strictEqual(result.stderr.includes("canary"), true);
    // ...and it actually asked the fallback instead.
    strictEqual(
        requests.some((request) => request.url === "/querybatch"),
        true,
    );
});

test("sends the canary in every npm batch and keeps it out of the findings", async () => {
    requests.length = 0;
    respond = (url) => {
        if (url === NPM_BULK_PATH)
            return { status: 200, body: { "adm-zip": [CANARY_ADVISORY] } };
        return { status: 200, body: {} };
    };

    const result = await runGate(LOCKFILE_WITH_PACKAGES);

    const bulk = requests.find((request) => request.url === NPM_BULK_PATH);
    // The canary rides along with the workspace's real packages...
    deepStrictEqual(bulk.body["adm-zip"], ["0.5.12"]);
    deepStrictEqual(bulk.body["left-pad"], ["1.3.0"]);
    // ...the answer is accepted, so OSV is never consulted...
    strictEqual(
        requests.some((request) => request.url === "/querybatch"),
        false,
    );
    // ...and the canary's own high-severity advisory is stripped before the
    // report is judged, so it is not reported against a tree that does not
    // contain adm-zip at all.
    strictEqual(result.status, 0, `expected a pass\n${result.stderr}`);
    strictEqual(
        result.stdout.includes("audit gate passed (0 high/critical advisories"),
        true,
    );
});

test("keeps the canary's advisory when the workspace really depends on the vulnerable version", async () => {
    // Stripping unconditionally would blind the gate to the one package it
    // uses as its probe. A real vulnerable copy must still fail the gate.
    requests.length = 0;
    respond = (url) => {
        if (url === NPM_BULK_PATH)
            return { status: 200, body: { "adm-zip": [CANARY_ADVISORY] } };
        return { status: 200, body: {} };
    };

    const result = await runGate({
        lockfileVersion: 3,
        packages: {
            "": { name: "fixture", version: "1.0.0" },
            "node_modules/adm-zip": { version: "0.5.12" },
        },
    });

    notStrictEqual(result.status, 0, `expected a failure\n${result.stderr}`);
    strictEqual(
        result.stderr.includes("GHSA-xcpc-8h2w-3j85"),
        true,
    );
});

test("isolates the canary when the workspace has a patched adm-zip version", async () => {
    requests.length = 0;
    respond = (url, body) => {
        if (url === NPM_BULK_PATH)
            return { body: body["adm-zip"].includes("0.5.12") ? { "adm-zip": [CANARY_ADVISORY] } : {} };
        return { status: 200, body: {} };
    };

    const result = await runGate({
        lockfileVersion: 3,
        packages: {
            "": { name: "fixture", version: "1.0.0" },
            "node_modules/adm-zip": { version: "0.6.1" },
        },
    });

    deepStrictEqual(requests.map((r) => r.body["adm-zip"]), [["0.5.12"], ["0.6.1"]]);
    strictEqual(result.status, 0, `expected a pass\n${result.stderr}`);
    strictEqual(
        result.stdout.includes("audit gate passed (0 high/critical advisories"),
        true,
    );
});

test("fails when OSV answers fewer results than it was asked about", async () => {
    // OSV's querybatch is positional. A short array used to be read as "the
    // rest are clean", quietly dropping packages from the audit.
    requests.length = 0;
    respond = (url) => {
        if (url === NPM_BULK_PATH) return { status: 200, body: {} };
        if (url === "/querybatch") return { status: 200, body: { results: [] } };
        return { status: 200, body: {} };
    };

    const result = await runGate(LOCKFILE_WITH_PACKAGES);

    notStrictEqual(result.status, 0, `expected non-zero exit\n${result.stdout}`);
    strictEqual(result.stdout.includes("audit gate passed"), false);
    strictEqual(result.stderr.includes("OSV answered 0 of 1"), true);
});

test("fails on an advisory the FALLBACK found after npm went silent", async () => {
    // The other half of the `{}` path. Falling through to OSV is only worth
    // anything if the fallback's findings are then judged: a run that
    // switched services and then printed "passed" over a real high-severity
    // advisory would be the same silent pass in a new disguise.
    requests.length = 0;
    const advisoryId = "GHSA-1111-2222-3333";
    respond = (url) => {
        if (url === NPM_BULK_PATH) return { status: 200, body: {} };
        if (url === "/querybatch")
            return {
                status: 200,
                body: { results: [{ vulns: [{ id: advisoryId }] }] },
            };
        if (url === `/vulns/${advisoryId}`)
            return {
                status: 200,
                body: {
                    id: advisoryId,
                    summary: "left-pad: pads left too enthusiastically",
                    database_specific: { severity: "HIGH" },
                },
            };
        return { status: 200, body: {} };
    };

    const result = await runGate(LOCKFILE_WITH_PACKAGES);

    notStrictEqual(result.status, 0, `expected non-zero exit\n${result.stdout}`);
    strictEqual(result.stdout.includes("audit gate passed"), false);
    // Named, so the failure is actionable rather than just red.
    strictEqual(result.stderr.includes(advisoryId), true);
});

test("treats a real package named 'error' as a package, not an error envelope", async () => {
    // npm has packages literally named "error", "message" and "code". When one
    // of them carries an advisory the bulk report has that key with an ARRAY
    // under it — the shape of every other entry — and the gate must judge it,
    // not mistake the report for an error payload and fall through to OSV.
    requests.length = 0;
    const advisoryId = "GHSA-9999-8888-7777";
    respond = (url) => {
        if (url === NPM_BULK_PATH)
            return {
                status: 200,
                body: {
                    "adm-zip": [CANARY_ADVISORY],
                    error: [
                        {
                            id: 2,
                            url: `https://github.com/advisories/${advisoryId}`,
                            title: "error: prototype pollution",
                            severity: "high",
                        },
                    ],
                },
            };
        return { status: 200, body: {} };
    };

    const result = await runGate({
        lockfileVersion: 3,
        packages: {
            "": { name: "fixture", version: "1.0.0" },
            "node_modules/error": { version: "10.4.0" },
        },
    });

    // Judged and blocked on the npm answer alone: no fallback was consulted.
    notStrictEqual(result.status, 0, `expected non-zero exit\n${result.stdout}`);
    strictEqual(result.stderr.includes(advisoryId), true);
    strictEqual(
        requests.some((request) => request.url === "/querybatch"),
        false,
    );
});

const MSAL_GHSA = "GHSA-xcx6-jx8p-x3h5";
const MSAL_NAME = "@azure/msal-node";
const MSAL_PATH = `node_modules/${MSAL_NAME}`;
const MSAL_PARENT = "node_modules/@azure/identity";
const SCOPED_LOCK = {
    lockfileVersion: 3,
    packages: {
        "": { name: "word-addin", version: "1.0.0" },
        [MSAL_PARENT]: { version: "4.14.0", dev: true, dependencies: { [MSAL_NAME]: "^6.0.0" } },
        [MSAL_PATH]: { version: "6.0.1", dev: true },
    },
};

function respondWithMsalAdvisory(source) {
    const advisory = { url: `https://github.com/advisories/${MSAL_GHSA}`, title: "MSAL test advisory", severity: "high" };
    respond = (url, body) => {
        if (url === NPM_BULK_PATH) {
            if (source === "OSV") return { body: {} };
            const report = { "adm-zip": [CANARY_ADVISORY] };
            if ((body[MSAL_NAME] ?? []).some((version) => version.startsWith("6."))) report[MSAL_NAME] = [advisory];
            return { body: report };
        }
        if (url === "/querybatch") return { body: { results: body.queries.map((q) =>
            q.package.name === MSAL_NAME && q.version.startsWith("6.") ? { vulns: [{ id: MSAL_GHSA }] } : {}) } };
        if (url === `/vulns/${MSAL_GHSA}`) return { body: {
            id: MSAL_GHSA, summary: advisory.title, database_specific: { severity: "HIGH" },
        } };
        return { body: {} };
    };
}

for (const source of ["npm", "OSV"]) {
    test(`${source}: allows only the approved development dependency scope`, async () => {
        respondWithMsalAdvisory(source);
        const result = await runGate(SCOPED_LOCK, { workspace: "word-addin" });
        strictEqual(result.status, 0, result.stderr);
        strictEqual(result.stdout.includes(`ALLOWLISTED high: ${MSAL_GHSA}`), true);
    });

    const outsideScopes = [
        ["another workspace with the same package name", () => {}, "backend"],
        ["a production dependency", (lock) => { delete lock.packages[MSAL_PATH].dev; }],
        ["another vulnerable version", (lock) => { lock.packages[MSAL_PATH].version = "6.0.2"; }],
        ["an unapproved installed path", (lock) => {
            lock.packages[`${MSAL_PARENT}/node_modules/${MSAL_NAME}`] = lock.packages[MSAL_PATH];
            delete lock.packages[MSAL_PATH];
        }],
        ["an additional consumer of the hoisted package", (lock) => {
            lock.packages["node_modules/new-consumer"] = { version: "1.0.0", dev: true, dependencies: { [MSAL_NAME]: "^6.0.0" } };
        }],
        ["an additional vulnerable production copy", (lock) => {
            lock.packages[`node_modules/runtime/node_modules/${MSAL_NAME}`] = { version: "6.0.1" };
        }],
        ["another vulnerable version alongside the approved one", (lock) => {
            lock.packages[`node_modules/runtime/node_modules/${MSAL_NAME}`] = { version: "6.0.2" };
        }],
        ["a direct dependency even if its dev flag is wrong", (lock) => {
            lock.packages[""].dependencies = { [MSAL_NAME]: "6.0.1" };
        }],
        ["a package with no verifiable incoming dependency", (lock) => {
            delete lock.packages[MSAL_PARENT].dependencies;
        }],
    ];
    for (const [description, mutate, workspace = "word-addin"] of outsideScopes) {
        test(`${source}: blocks ${description}`, async () => {
            respondWithMsalAdvisory(source);
            const lock = structuredClone(SCOPED_LOCK);
            mutate(lock);
            const result = await runGate(lock, { workspace });
            notStrictEqual(result.status, 0, result.stdout);
            strictEqual(result.stderr.includes("outside the approved dependency scope"), true, result.stderr);
        });
    }

    test(`${source}: does not mistake a patched production copy for an affected copy`, async () => {
        respondWithMsalAdvisory(source);
        const lock = structuredClone(SCOPED_LOCK);
        lock.packages[`node_modules/runtime/node_modules/${MSAL_NAME}`] = { version: "7.1.0" };
        const result = await runGate(lock, { workspace: "word-addin" });
        strictEqual(result.status, 0, result.stderr);
    });
}

test("rejects an advisory-only exception before consulting any service", async () => {
    requests.length = 0;
    const result = await runGate(SCOPED_LOCK, {
        workspace: "word-addin",
        allowlist: [{ ghsa: MSAL_GHSA, reason: "Only developer tools" }],
    });
    notStrictEqual(result.status, 0);
    strictEqual(result.stderr.includes("Invalid scoped audit exception"), true);
    deepStrictEqual(requests, []);
});

test("the removed Undici exception cannot suppress a production finding", async () => {
    const ghsa = "GHSA-xjj6-f33q-929c";
    respond = () => ({ body: {
        "adm-zip": [CANARY_ADVISORY],
        undici: [{ url: `https://github.com/advisories/${ghsa}`, title: "Undici test advisory", severity: "high" }],
    } });
    const result = await runGate({ packages: { "node_modules/undici": { version: "7.29.1" } } }, { workspace: "frontend" });
    notStrictEqual(result.status, 0);
    strictEqual(result.stderr.includes(ghsa), true);
});

test("does not lose an unmatchable finding when merging the same advisory ID", async () => {
    respond = () => ({ body: {
        "adm-zip": [CANARY_ADVISORY],
        [MSAL_NAME]: [{ url: `https://github.com/advisories/${MSAL_GHSA}`, title: "Scoped finding", severity: "high" }],
        unknown: [{ url: `https://github.com/advisories/${MSAL_GHSA}`, title: "Unmatchable finding", severity: "high" }],
    } });
    const result = await runGate(SCOPED_LOCK, { workspace: "word-addin" });
    notStrictEqual(result.status, 0);
    strictEqual(result.stderr.includes("outside the approved dependency scope"), true);
});

for (const field of ["optionalDependencies", "peerDependencies"]) {
    test(`checks additional consumers through ${field}`, async () => {
        respondWithMsalAdvisory("npm");
        const lock = structuredClone(SCOPED_LOCK);
        lock.packages["node_modules/new-consumer"] = { version: "1.0.0", dev: true, [field]: { [MSAL_NAME]: "^6.0.0" } };
        const result = await runGate(lock, { workspace: "word-addin" });
        notStrictEqual(result.status, 0);
        strictEqual(result.stderr.includes("outside the approved dependency scope"), true);
    });
}

for (const versions of [["0.5.16"], ["0.5.12", "0.5.16"], ["0.6.1", "0.5.16"]]) {
    test(`retains real adm-zip findings independently of the canary: ${versions.join(", ")}`, async () => {
        requests.length = 0;
        const realGhsa = "GHSA-1111-2222-4444";
        respond = (url, body) => {
            if (url !== NPM_BULK_PATH) return { body: {} };
            const queriedVersions = body["adm-zip"];
            // Separate requests are essential: the response has no per-version
            // keys, so combining these versions would lose their attribution.
            strictEqual(queriedVersions.length, 1);
            if (queriedVersions[0] === "0.5.12") return { body: { "adm-zip": [CANARY_ADVISORY] } };
            if (queriedVersions[0] === "0.5.16") return { body: { "adm-zip": [{
                url: `https://github.com/advisories/${realGhsa}`, title: "Real installed-version advisory", severity: "high",
            }] } };
            return { body: {} };
        };
        const packages = Object.fromEntries(versions.map((version, index) => [
            `node_modules/consumer-${index}/node_modules/adm-zip`, { version },
        ]));
        const result = await runGate({ lockfileVersion: 3, packages });
        notStrictEqual(result.status, 0, result.stdout);
        strictEqual(result.stderr.includes(realGhsa), true, result.stderr);
        strictEqual(result.stderr.includes(CANARY_ADVISORY.url.split("/").pop()), versions.includes("0.5.12"));
        strictEqual(requests.some((r) => r.url === "/querybatch"), false);
    });
}

test("a silent isolated canary probe falls back to OSV instead of trusting the real query", async () => {
    requests.length = 0;
    respond = (url, body) => {
        if (url === NPM_BULK_PATH) return { body: {} };
        if (url === "/querybatch") return { body: { results: body.queries.map(() => ({})) } };
        return { body: {} };
    };
    const result = await runGate({ packages: { "node_modules/adm-zip": { version: "0.6.1" } } });
    strictEqual(result.status, 0, result.stderr);
    strictEqual(result.stderr.includes("canary"), true);
    strictEqual(requests.some((r) => r.url === "/querybatch"), true);
    // Only the probe was sent to npm. The actual installed version was
    // independently checked by OSV after npm failed the canary contract.
    deepStrictEqual(requests.filter((r) => r.url === NPM_BULK_PATH).map((r) => r.body), [{ "adm-zip": ["0.5.12"] }]);
});

test("a successful isolated probe does not hide a malformed real-package response", async () => {
    respond = (url, body) => {
        if (url === NPM_BULK_PATH && body["adm-zip"]?.[0] === "0.5.12") {
            return { body: { "adm-zip": [CANARY_ADVISORY] } };
        }
        return { body: { error: "service unavailable" } };
    };
    const result = await runGate({ packages: { "node_modules/adm-zip": { version: "0.6.1" } } });
    notStrictEqual(result.status, 0);
    strictEqual(result.stderr.includes("Both advisory services failed"), true);
});
