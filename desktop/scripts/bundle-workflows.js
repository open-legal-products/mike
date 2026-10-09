// Release-time network access only. The backend's existing importer validates
// the source archive; package its result and asset bytes for offline startup.
const fs = require("node:fs/promises");
const path = require("node:path");
const { writeBundledWorkflows } = require("../src/local/workflows");

async function main() {
  const backend = path.resolve(__dirname, "../../backend");
  const { prepareWorkflowCatalog, removePreparedWorkflowCatalog, validateWorkflowCatalogDocument } =
    require(path.join(backend, "dist/lib/workflowCatalogSource.js"));
  const prepared = await prepareWorkflowCatalog();
  try {
    const document = validateWorkflowCatalogDocument(JSON.parse(await fs.readFile(prepared.catalogPath, "utf8")));
    await writeBundledWorkflows(document, path.join(backend, "dist/workflow-catalog"));
    console.log(`Bundled ${document.workflows.length} workflows at ${document.source_commit}`);
  } finally {
    await removePreparedWorkflowCatalog(prepared);
  }
}

main().catch((error) => {
  console.error("Could not bundle offline workflows:", error.message);
  process.exitCode = 1;
});
