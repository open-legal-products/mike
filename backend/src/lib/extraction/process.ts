// Sequential requests reuse parser imports. No database or application boot.
import { EXTRACTION_OPS, type ExtractionOp } from "./ops";
import { EXTRACTION_MAX_TEXT_BYTES, ExtractionLimitError, isAllocationFailure } from "./limits";

process.on("message", (request: { op: ExtractionOp; bytes: ArrayBuffer; fileType: string }) => {
  void (async () => {
    try {
      const result = await EXTRACTION_OPS[request.op](request.bytes, request.fileType);
      const text = typeof result === "string" ? result : result.text;
      // Bound IPC output before it can allocate a large string in the parent.
      if (Buffer.byteLength(text) > EXTRACTION_MAX_TEXT_BYTES) {
        throw new ExtractionLimitError("extracted text exceeds 16 MB");
      }
      process.send?.({ ok: true, result });
    } catch (error) {
      const limited = error instanceof ExtractionLimitError || isAllocationFailure(error);
      process.send?.({
        ok: false, limited,
        message: limited ? "parser resource budget exceeded" : error instanceof Error ? error.message : "document extraction failed",
      });
    }
  })();
});

process.on("disconnect", () => {
  if (process.platform !== "win32") {
    try { process.kill(-process.pid, "SIGKILL"); } catch { process.exit(1); }
  } else process.exit(1);
});
