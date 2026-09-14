import "dotenv/config";
import { createServerSupabase } from "../lib/supabase";
import { syncWorkflowCatalog } from "../lib/workflowCatalogSync";

async function main() {
  const result = await syncWorkflowCatalog(createServerSupabase());
  console.log(
    `Synced ${result.workflows} Mike workflows and ${result.assets} assets from ${result.sourceCommit}`,
  );
}

void main().catch((error) => {
  console.error("SambaNova workflow sync failed", error);
  process.exit(1);
});
