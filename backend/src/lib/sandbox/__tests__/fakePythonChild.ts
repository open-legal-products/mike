process.send?.({ type: "ready" });
process.on("message", (message: { code: string }) => {
    const [mode, arg] = message.code.split(":");
    if (mode === "hang") return;
    if (mode === "exit") process.exit(0);
    setTimeout(() => {
        process.send?.({ type: "done", outcome: { ok: true, stdout: mode, stdoutTruncated: false, outputs: [], durationMs: 1 } });
    }, Number(arg ?? 0));
});
