import { readFile } from "fs/promises";
import { contentTypeForDocumentType } from "./documentTypes";
import { storageEnabled, uploadFile } from "./storage";
import {
  prepareWorkflowCatalog,
  removePreparedWorkflowCatalog,
  validateWorkflowCatalogDocument,
  type WorkflowCatalogSourceOptions,
  type WorkflowCatalogSourceWorkflow,
} from "./workflowCatalogSource";
import type { Db } from "./supabase";

export type WorkflowCatalogSyncResult = {
  workflows: number;
  assets: number;
  sourceCommit: string;
};

function metadataWithoutTemporaryAssets(
  workflow: WorkflowCatalogSourceWorkflow,
  assets: Array<{
    filename: string;
    file_type: string;
    storage_path: string;
    size_bytes: number;
    content_hash: string;
  }>,
) {
  const { assets: _assets, ...metadata } = workflow;
  return { ...metadata, assets };
}

export async function syncWorkflowCatalog(
  db: Db,
  options: WorkflowCatalogSourceOptions = {},
): Promise<WorkflowCatalogSyncResult> {
  const prepared = await prepareWorkflowCatalog(options);
  try {
    const document = validateWorkflowCatalogDocument(
      JSON.parse(await readFile(prepared.catalogPath, "utf8")) as unknown,
    );
    let assetCount = 0;
    const databaseWorkflows = [];
    const hasAssets = document.workflows.some(
      (workflow) => workflow.assets.length > 0,
    );
    if (hasAssets && !storageEnabled) {
      throw new Error(
        "Workflow assets require configured S3-compatible storage",
      );
    }

    for (const workflow of document.workflows) {
      const databaseAssets = [];
      for (const asset of workflow.assets) {
        if (storageEnabled) {
          const storagePath =
            `mike-workflows/${workflow.workflow_key}/` +
            `${asset.content_hash}/${asset.filename}`;
          const bytes = await readFile(asset.temporary_path);
          await uploadFile(
            storagePath,
            bytes.buffer.slice(
              bytes.byteOffset,
              bytes.byteOffset + bytes.byteLength,
            ) as ArrayBuffer,
            contentTypeForDocumentType(asset.file_type),
          );
          databaseAssets.push({
            filename: asset.filename,
            file_type: asset.file_type,
            storage_path: storagePath,
            size_bytes: asset.size_bytes,
            content_hash: asset.content_hash,
          });
          assetCount += 1;
        }
      }
      databaseWorkflows.push(
        metadataWithoutTemporaryAssets(workflow, databaseAssets),
      );
    }

    const { error } = await db.rpc("replace_mike_workflows", {
      p_source_commit: document.source_commit,
      p_workflows: databaseWorkflows,
    });
    if (error) throw error;

    return {
      workflows: databaseWorkflows.length,
      assets: assetCount,
      sourceCommit: document.source_commit,
    };
  } finally {
    await removePreparedWorkflowCatalog(prepared);
  }
}
