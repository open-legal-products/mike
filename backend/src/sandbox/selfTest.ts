// Run inside the sandbox container after a deploy: proves the interpreter and
// the renderer work and that the container really has no network, probed
// from Node as well as from Python, whose sockets never work under Pyodide.
import net from "node:net";
import { createSandboxCore } from "../lib/sandbox";

function nodeCanConnect(): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = net.connect({ host: "1.1.1.1", port: 53, timeout: 3000 });
        socket.once("connect", () => {
            socket.destroy();
            resolve(true);
        });
        socket.once("timeout", () => socket.destroy(new Error("timeout")));
        socket.once("error", () => resolve(false));
    });
}

async function main() {
    const core = createSandboxCore();
    const failures: string[] = [];
    const python = await core.runPython({ code: "print(1 + 1)", docs: [] });
    if (!python.ok || python.stdout.trim() !== "2") failures.push(`python: ${JSON.stringify(python)}`);
    const network = await core.runPython({
        code: "import socket\nsocket.create_connection(('1.1.1.1', 53), timeout=3)\nprint('connected')",
        docs: [],
    });
    if (network.ok) failures.push("network: a socket connection succeeded");
    if (await nodeCanConnect()) failures.push("network: the container reached the internet");
    const pdf = await core.render({ html: "<!doctype html><html><body><p>ok</p></body></html>", format: "pdf" });
    if (!pdf.ok || pdf.bytes.subarray(0, 4).toString() !== "%PDF") failures.push(`render: ${JSON.stringify(pdf)}`);
    await core.shutdown();
    if (failures.length) {
        console.error(failures.join("\n"));
        process.exit(1);
    }
    console.log("ok");
}

void main();
