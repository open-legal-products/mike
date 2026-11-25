// Word-document comparison behind a replaceable engine. Docxodus is the only
// engine today; another one implements `DocxDiffEngine` and is added to
// ENGINES, and `DOCX_DIFF_ENGINE` selects it per deployment.

import { docxodusDiffEngine } from "./docxodus";
import type { DocxDiffEngine } from "./types";

export { DocxDiffError, type DocxDiffEngine } from "./types";

export const DEFAULT_DOCX_DIFF_ENGINE = "docxodus";

const ENGINES: ReadonlyMap<string, DocxDiffEngine> = new Map([
  [docxodusDiffEngine.id, docxodusDiffEngine],
]);

/**
 * The configured comparison engine. An unknown name is a deployment mistake,
 * so it fails loudly instead of silently comparing with a different engine.
 */
export function getDocxDiffEngine(
  configured: string | undefined = process.env.DOCX_DIFF_ENGINE,
): DocxDiffEngine {
  const id = configured?.trim().toLowerCase() || DEFAULT_DOCX_DIFF_ENGINE;
  const engine = ENGINES.get(id);
  if (!engine) {
    throw new Error(
      `Unknown DOCX_DIFF_ENGINE "${id}". Available: ${[...ENGINES.keys()].join(", ")}.`,
    );
  }
  return engine;
}
