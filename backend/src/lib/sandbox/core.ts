// The sandbox proper, with no knowledge of how it is reached: the sidecar's
// socket server and the in-process fallback both call this.
import { sandboxLimits } from "./limits";
import { PythonRunner, type PythonRunnerOptions } from "./python";
import { VisualRenderer } from "./render";
import type { PythonRequest, SandboxClient } from "./types";

export type SandboxCore = SandboxClient & { shutdown(): Promise<void> };

export function createSandboxCore(options: PythonRunnerOptions = {}): SandboxCore {
    const python = new PythonRunner(options);
    const renderer = new VisualRenderer(options.limits);
    const limits = { ...sandboxLimits(), ...options.limits };
    return {
        async runPython(req: PythonRequest, opts) {
            if (req.docs.length > limits.maxDocs) return { ok: false, code: "crashed" };
            return python.run(req, opts);
        },
        render: renderer.render.bind(renderer),
        async capabilities() {
            return { python: python.available(), render: await renderer.available() };
        },
        async shutdown() {
            python.shutdown();
            await renderer.shutdown();
        },
    };
}
