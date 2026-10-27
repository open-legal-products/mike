import { envInt } from "../runtimeConfig";

export function sandboxLimits() {
    return {
        pythonTimeoutMs: Math.min(envInt("PYTHON_SANDBOX_TIMEOUT_MS", 30_000), 120_000),
        pythonMemoryMb: envInt("PYTHON_SANDBOX_MEMORY_MB", 1024),
        pythonConcurrency: 2,
        renderTimeoutMs: 20_000,
        renderConcurrency: 2,
        /** How long a request waits for a slot before it is reported busy. */
        queueWaitMs: 20_000,
        stdoutChars: 20_000,
        resultBytes: 2 * 1024 * 1024,
        maxOutputs: 3,
        maxDocs: 10,
        maxInputBytes: 25 * 1024 * 1024,
    };
}

export function codeAnalysisEnabled(): boolean {
    return process.env.CODE_ANALYSIS_ENABLED !== "false";
}
