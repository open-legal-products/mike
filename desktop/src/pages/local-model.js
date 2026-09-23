/* No URLs, model names or executable arguments cross the privileged bridge. */
const bridge = window.mikeDesktop;
const byId = (id) => document.getElementById(id);
const gb = (bytes) => (bytes / 1e9).toFixed(1);
let busy = false;
const activeStates = new Set(["starting", "downloading", "verifying", "benchmarking"]);

function render(snapshot) {
  busy = activeStates.has(snapshot.state);
  const ready = snapshot.state === "ready";
  byId("model-heading").textContent = snapshot.modelName;
  byId("model-detail").textContent = `${gb(snapshot.downloadBytes)} GB optional download · Apache 2.0 · runs on your Mac`;
  byId("hardware").textContent = snapshot.hardware?.recommendation || "Device information is unavailable. You can continue without a local model.";
  byId("state").textContent = ({"not-installed":"Not downloaded", starting:"Starting", downloading:"Downloading", verifying:"Checking model", ready:"Ready", benchmarking:"Measuring", cancelled:"Download cancelled", error:"Needs attention"})[snapshot.state] || "Checking";
  byId("status").textContent = ready ? "Your local model is ready. Opening the workspace will select it if you haven't chosen a model yet." : "";
  byId("error").textContent = snapshot.error || "";
  byId("error").hidden = !snapshot.error;
  byId("progress-area").hidden = !busy;
  if (snapshot.state === "downloading") {
    byId("progress").value = snapshot.progress || 0;
    byId("progress-label").textContent = `Downloading ${gb(snapshot.completedBytes || 0)} of ${gb(snapshot.downloadBytes)} GB`;
  } else {
    byId("progress").removeAttribute("value");
    byId("progress-label").textContent = byId("state").textContent;
  }
  byId("install").hidden = ready;
  byId("install").disabled = busy || !snapshot.hardware?.supported;
  byId("install").textContent = snapshot.state === "cancelled" || snapshot.state === "error" ? "Retry download / check" : `Download local AI · ${gb(snapshot.downloadBytes)} GB`;
  byId("cancel").hidden = !busy;
  byId("continue").disabled = busy;
  byId("continue").textContent = ready ? "Open local workspace" : "Continue without local AI";
  byId("continue").classList.toggle("primary", ready);
  byId("no-model").hidden = ready;
  byId("measurement").hidden = !ready && !snapshot.benchmark;
  byId("benchmark").disabled = busy || !ready;
  byId("server").disabled = busy;
  byId("export").disabled = busy;
  byId("model-source").href = snapshot.modelId === "ollama/qwen3.5:4b" ? "https://huggingface.co/Qwen/Qwen3.5-4B" : "https://huggingface.co/Qwen/Qwen3.5-2B";
  const result = snapshot.benchmark;
  if (result) {
    const rate = Number.isFinite(result.tokensPerSecond) ? `${result.tokensPerSecond.toFixed(1)} tokens/sec` : "throughput unavailable";
    const passed = result.checks.filter((check) => check.passed).length;
    byId("results").textContent = `${passed}/${result.totalChecks} expected facts correct · ${(result.latencyMs / 1000).toFixed(1)} sec · ${rate}. ${result.passed ? "Smoke check passed." : "Check missed expected facts; review outputs before relying on this model."}`;
  }
}
async function perform(action) {
  try { const state = await action(); if (state) render(state); }
  catch { byId("error").hidden = false; byId("error").textContent = "This action could not finish. Try again, or reopen Local AI from the Mike menu."; }
}
byId("install").addEventListener("click", () => perform(() => bridge.installLocalModel()));
byId("cancel").addEventListener("click", () => perform(() => bridge.cancelLocalModel()));
byId("benchmark").addEventListener("click", () => perform(() => bridge.benchmarkLocalModel()));
byId("continue").addEventListener("click", () => { if (!busy) void perform(() => bridge.openLocalWorkspace()); });
byId("server").addEventListener("click", () => { if (!busy) void bridge.openConnect(); });
byId("export").addEventListener("click", async () => {
  try {
    const saved = await bridge.exportLocalModelBrief();
    byId("export-status").textContent = saved ? "Brief saved. It contains model and device measurements, with a checklist for your firm. No conversations or documents are included." : "";
  } catch { byId("export-status").textContent = "The brief could not be saved. Try again."; }
});
bridge.onLocalModelStatus(render);
void perform(() => bridge.localModelStatus());
