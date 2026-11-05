import "../instrument";
import { AppError } from "../lib/appError";
import { createServerSupabase } from "../lib/supabase";
import {
  flushSentry,
  reportError,
  setOperation,
} from "../lib/observability/sentry";
import { syncWorkflowCatalog } from "../lib/workflowCatalogSync";

async function main() {
  setOperation("workflows.sync");
  const result = await syncWorkflowCatalog(createServerSupabase());
  console.log(
    `Synced ${result.workflows} Mike workflows and ${result.assets} assets from ${result.sourceCommit}`,
  );
}

void main().catch(async (error) => {
  // The sync's own failure (a git fetch, an upload, the replace RPC) is the
  // cause, so its code reaches Sentry as failure_code under one kind. The
  // reported object is also what gets logged, so the console bridge files
  // nothing twice.
  const failure = new AppError(
    "workflows.sync_failed",
    "Mike workflow sync failed",
    { cause: error },
  );
  reportError(failure, { tags: { component: "workflow-sync" }, level: "fatal" });
  console.error("Mike workflow sync failed", failure);
  await flushSentry();
  process.exit(1);
});
