import { fork } from "node:child_process";
import path from "node:path";
import { googleDriveLimits } from "./googleDriveLimits";
import { GoogleDriveUserError } from "./googleDriveHttp";

let activeParsers = 0;

/** Parse untrusted binaries off the API event loop, with bounded concurrency,
 * a V8 heap limit and a wall-clock kill. Download and DOCX expansion limits are
 * enforced separately; V8's heap limit is not a total process RSS limit. */
export async function extractGoogleDriveBinary(
    filename: string,
    mimeType: string,
): Promise<string> {
    if (activeParsers >= 2) {
        throw new GoogleDriveUserError(
            "Google Drive file readers are busy. Please try again.",
        );
    }
    activeParsers++;
    const limits = googleDriveLimits();
    try {
        return await new Promise<string>((resolve, reject) => {
            const extension = __filename.endsWith(".ts") ? "ts" : "js";
            const child = fork(
                path.join(__dirname, `googleDriveExtractChild.${extension}`),
                [],
                {
                    execArgv: [
                        ...(extension === "ts" ? ["--import", "tsx"] : []),
                        `--max-old-space-size=${limits.parserHeapMb}`,
                    ],
                    stdio: ["ignore", "ignore", "ignore", "ipc"],
                    serialization: "advanced",
                    // Parsers never need deployment secrets or network credentials.
                    env: {
                        NODE_ENV: process.env.NODE_ENV,
                        PATH: process.env.PATH,
                    },
                },
            );
            let settled = false;
            const finish = (text?: string) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                child.kill("SIGKILL");
                if (text !== undefined) resolve(text);
                else
                    reject(
                        new GoogleDriveUserError(
                            "This Drive file could not be read within the processing limits. Open it in Google Drive.",
                        ),
                    );
            };
            const timer = setTimeout(() => finish(), limits.parseMs);
            child.once("error", () => finish());
            child.once("exit", () => finish());
            child.once("message", (message: unknown) => {
                const text = (message as { text?: unknown } | null)?.text;
                finish(typeof text === "string" ? text : undefined);
            });
            child.send(
                { filename, mimeType, expandedBytes: limits.expandedBytes },
                (error) => {
                    if (error) finish();
                },
            );
        });
    } finally {
        activeParsers--;
    }
}
