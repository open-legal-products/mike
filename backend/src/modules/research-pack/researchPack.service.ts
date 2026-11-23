import { existsSync } from "node:fs";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { join } from "node:path";

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 512 * 1024;
const MAX_STDERR_BYTES = 8 * 1024;
const TIMEOUT_MS = 10_000;
const MAX_CONCURRENT = 2;
let active = 0;

export type ResearchPackVerification = {
    schema: "arcs.verify.research_workspace_report.v0.1";
    integrity: "pass" | "fail";
    authenticity: "not_established";
    failures: unknown[];
    [key: string]: unknown;
};

function verifierDirectory(): string {
    const candidates = [
        join(process.cwd(), "src/lib/arcs_verify"),
        join(process.cwd(), "backend/src/lib/arcs_verify"),
    ];
    const found = candidates.find((candidate) => existsSync(join(candidate, "bridge.py")));
    if (!found) throw new Error("research_pack_verifier_unavailable");
    return found;
}

function validReport(value: unknown): value is ResearchPackVerification {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const report = value as Record<string, unknown>;
    return (
        report.schema === "arcs.verify.research_workspace_report.v0.1" &&
        (report.integrity === "pass" || report.integrity === "fail") &&
        report.authenticity === "not_established" &&
        Array.isArray(report.failures)
    );
}

export async function verifyResearchPack(
    bytes: Buffer,
): Promise<ResearchPackVerification> {
    if (bytes.length > MAX_BYTES) throw new Error("research_pack_too_large");
    if (active >= MAX_CONCURRENT) throw new Error("research_pack_busy");
    active += 1;
    try {
        const verifierPath = verifierDirectory();
        const cwd = join(verifierPath, "..");
        return await new Promise((resolve, reject) => {
            let child: ChildProcessWithoutNullStreams;
            try {
                child = spawn("/usr/bin/python3", ["-B", "-m", "arcs_verify.bridge"], {
                    cwd,
                    env: { PYTHONUTF8: "1" },
                    stdio: ["pipe", "pipe", "pipe"],
                    windowsHide: true,
                });
            } catch {
                reject(new Error("research_pack_verifier_unavailable"));
                return;
            }

            let output = "";
            let outputBytes = 0;
            let stderrBytes = 0;
            let failure: string | undefined;
            let settled = false;
            const timeout = setTimeout(() => {
                failure = failure ?? "research_pack_timeout";
                child.kill("SIGKILL");
            }, TIMEOUT_MS);
            const failAndKill = (code: string) => {
                failure = failure ?? code;
                child.kill("SIGKILL");
            };

            child.stdout.setEncoding("utf8");
            child.stderr.setEncoding("utf8");
            child.stdout.on("data", (chunk: string) => {
                outputBytes += Buffer.byteLength(chunk);
                if (outputBytes > MAX_OUTPUT_BYTES) failAndKill("research_pack_report_too_large");
                else output += chunk;
            });
            child.stderr.on("data", (chunk: string) => {
                stderrBytes += Buffer.byteLength(chunk);
                if (stderrBytes > MAX_STDERR_BYTES) failAndKill("research_pack_verifier_failed");
            });
            child.stdin.once("error", () => failAndKill("research_pack_verifier_io"));
            child.once("error", () => failAndKill("research_pack_verifier_unavailable"));
            child.once("close", (code) => {
                clearTimeout(timeout);
                if (settled) return;
                settled = true;
                if (failure) return reject(new Error(failure));
                if (code !== 0) return reject(new Error("research_pack_verifier_failed"));
                try {
                    const report: unknown = JSON.parse(output);
                    if (!validReport(report)) throw new Error();
                    resolve(report);
                } catch {
                    reject(new Error("research_pack_verifier_invalid_output"));
                }
            });
            child.stdin.end(bytes);
        });
    } finally {
        active -= 1;
    }
}
