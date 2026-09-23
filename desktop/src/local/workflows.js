const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");

function verifiedAsset(bytes, asset) {
  if (bytes.length !== asset.size_bytes ||
      createHash("sha256").update(bytes).digest("hex") !== asset.content_hash) {
    throw new Error("A bundled workflow asset failed its integrity check. Reinstall Mike.");
  }
}

// Input has passed the backend's canonical workflow validation. Remove build
// machine paths so the artifact can be moved into any signed app bundle.
async function writeBundledWorkflows(document, destination) {
  await fs.rm(destination, { recursive: true, force: true });
  await fs.mkdir(path.join(destination, "assets"), { recursive: true });
  const workflows = [];
  for (const workflow of document.workflows) {
    const assets = [];
    for (const asset of workflow.assets) {
      const bytes = await fs.readFile(asset.temporary_path);
      verifiedAsset(bytes, asset);
      await fs.writeFile(path.join(destination, "assets", asset.content_hash), bytes);
      const { temporary_path, ...portable } = asset;
      assets.push(portable);
    }
    workflows.push({ ...workflow, assets });
  }
  await fs.writeFile(path.join(destination, "catalog.json"), JSON.stringify({
    format_version: 1,
    ...document,
    workflows,
  }));
}

// Mirrors the backend workflow sync's storage keys and atomic replacement RPC,
// using the app's own Postgres connection before any clients can access it.
// There are no network reads here, including on a fresh installation.
async function installBundledWorkflows({ client, backendDir, storageRoot }) {
  const directory = path.join(backendDir, "dist/workflow-catalog");
  let document;
  try {
    document = JSON.parse(await fs.readFile(path.join(directory, "catalog.json"), "utf8"));
  } catch {
    throw new Error("The offline workflow catalog is missing. Rebuild or reinstall Mike.");
  }
  if (document.format_version !== 1 || !/^[0-9a-f]{40}$/.test(document.source_commit) ||
      !Array.isArray(document.workflows) || !document.workflows.length) {
    throw new Error("The bundled workflow catalog is invalid. Reinstall Mike.");
  }
  const installed = await client.query(
    "select count(*)::int as count from public.mike_workflows where active and source_commit = $1",
    [document.source_commit],
  );
  if (installed.rows[0]?.count === document.workflows.length) return;

  const workflows = [];
  for (const workflow of document.workflows) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(workflow.workflow_key) || !Array.isArray(workflow.assets)) {
      throw new Error("The bundled workflow entry is invalid. Reinstall Mike.");
    }
    const assets = [];
    for (const asset of workflow.assets) {
      if (!/^[0-9a-f]{64}$/.test(asset.content_hash) || typeof asset.filename !== "string" ||
          !asset.filename || asset.filename.startsWith(".") || /[/\\\0]/.test(asset.filename)) {
        throw new Error("The bundled workflow asset path is invalid. Reinstall Mike.");
      }
      const bytes = await fs.readFile(path.join(directory, "assets", asset.content_hash));
      verifiedAsset(bytes, asset);
      const storagePath = `mike-workflows/${workflow.workflow_key}/${asset.content_hash}/${asset.filename}`;
      const target = path.join(storageRoot, storagePath);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, bytes);
      assets.push({ ...asset, storage_path: storagePath });
    }
    workflows.push({ ...workflow, assets });
  }
  await client.query("select public.replace_mike_workflows($1::text, $2::jsonb)", [
    document.source_commit, JSON.stringify(workflows),
  ]);
}

module.exports = { writeBundledWorkflows, installBundledWorkflows };
