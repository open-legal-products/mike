import "../instrument";
import { createServerSupabase } from "../lib/supabase";
import { backfillDocumentText } from "../modules/documents/documents.service";
import { safeError } from "../lib/safeError";

// One bounded batch per invocation. The regular maintenance sweep continues
// automatically; --retry-failed explicitly requeues terminal extraction failures.
void backfillDocumentText(createServerSupabase(), {
  limit: 500, retryFailed: process.argv.includes("--retry-failed"),
}).then((queued) => console.log(`Queued ${queued} document text extractions.`))
  .catch((error) => { console.error("Document text backfill failed", safeError(error)); process.exitCode = 1; });
