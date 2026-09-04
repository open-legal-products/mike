import crypto from "node:crypto";
import { Router, type Response } from "express";
import { requireAuth, requireMfaIfEnrolled } from "../middleware/auth";
import { sendInternalError } from "../lib/httpError";
import {
  deleteFile,
  downloadFile,
  getSignedUploadUrl,
  headFile,
  storageEnabled,
} from "../lib/storage";
import {
  deletePlaybook,
  getPlaybook,
  importPlaybookFromDocx,
  listPlaybookRuns,
  listPlaybooks,
  PlaybookImportError,
  PlaybookRequestError,
  playbookConfiguration,
  publishPlaybook,
  reviewWithPlaybook,
  updatePlaybookDraft,
} from "../lib/playbooks";

export const playbooksRouter = Router();
playbooksRouter.use(requireAuth);

const DOCX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
/** Word playbooks are prose; anything this large is not one. */
const MAX_PLAYBOOK_SOURCE_BYTES = 25 * 1024 * 1024;
const UPLOAD_URL_TTL_SECONDS = 900;

/**
 * Staged uploads live under a per-user prefix so a request can only ever name
 * an object its own account uploaded.
 */
function importPrefix(userId: string): string {
  return `playbooks/${userId}/imports/`;
}

function sendError(res: Response, error: unknown): void {
  if (error instanceof PlaybookImportError) {
    return void res.status(400).json({
      detail: error.message,
      code: error.code,
      importAttemptId: error.attemptId,
      stage: error.stage,
    });
  }
  if (error instanceof PlaybookRequestError) {
    return void res.status(error.status).json({ detail: error.message });
  }
  sendInternalError(res, error);
}

playbooksRouter.get("/configuration", async (_req, res) => {
  try {
    res.json(await playbookConfiguration(res.locals.userId as string));
  } catch (error) {
    sendError(res, error);
  }
});

playbooksRouter.get("/", async (_req, res) => {
  try {
    res.json(await listPlaybooks(res.locals.userId as string));
  } catch (error) {
    sendError(res, error);
  }
});

/**
 * Hand back a presigned PUT for the source .docx. The browser uploads straight
 * to object storage, matching how documents are uploaded, so the API never
 * buffers the file.
 */
playbooksRouter.post(
  "/import/upload-url",
  requireMfaIfEnrolled,
  async (req, res) => {
    try {
      if (!storageEnabled) {
        return void res
          .status(503)
          .json({ detail: "Object storage is not configured." });
      }
      const filename =
        typeof req.body?.filename === "string" ? req.body.filename.trim() : "";
      const sizeBytes = Number(req.body?.sizeBytes);
      if (!/\.docx$/i.test(filename)) {
        return void res
          .status(400)
          .json({ detail: "Playbook import currently requires a .docx file." });
      }
      if (
        !Number.isInteger(sizeBytes) ||
        sizeBytes <= 0 ||
        sizeBytes > MAX_PLAYBOOK_SOURCE_BYTES
      ) {
        return void res.status(400).json({
          detail: `The playbook must be between 1 byte and ${Math.floor(
            MAX_PLAYBOOK_SOURCE_BYTES / (1024 * 1024),
          )} MB.`,
        });
      }

      const storageKey = `${importPrefix(
        res.locals.userId as string,
      )}${crypto.randomUUID()}.docx`;
      const uploadUrl = await getSignedUploadUrl(
        storageKey,
        DOCX_CONTENT_TYPE,
        sizeBytes,
        UPLOAD_URL_TTL_SECONDS,
      );
      if (!uploadUrl) {
        return void res
          .status(503)
          .json({ detail: "Could not prepare the upload. Please try again." });
      }
      res.status(201).json({
        uploadUrl,
        storageKey,
        contentType: DOCX_CONTENT_TYPE,
        expiresInSeconds: UPLOAD_URL_TTL_SECONDS,
      });
    } catch (error) {
      sendError(res, error);
    }
  },
);

playbooksRouter.post("/import", requireMfaIfEnrolled, async (req, res) => {
  const userId = res.locals.userId as string;
  const storageKey =
    typeof req.body?.storageKey === "string" ? req.body.storageKey : "";
  let staged = false;
  try {
    // The prefix is the ownership boundary: a caller cannot compile from an
    // object another account staged, or from anywhere else in the bucket.
    if (!storageKey.startsWith(importPrefix(userId))) {
      return void res
        .status(400)
        .json({ detail: "Upload the playbook before importing it." });
    }
    const stat = await headFile(storageKey);
    if (!stat) {
      return void res
        .status(400)
        .json({ detail: "The uploaded playbook is no longer available." });
    }
    staged = true;
    if (stat.size > MAX_PLAYBOOK_SOURCE_BYTES) {
      return void res
        .status(400)
        .json({ detail: "The uploaded playbook is too large." });
    }
    const bytes = await downloadFile(storageKey);
    if (!bytes) {
      return void res
        .status(400)
        .json({ detail: "The uploaded playbook could not be read." });
    }

    const model = typeof req.body?.model === "string" ? req.body.model : "";
    const name = typeof req.body?.name === "string" ? req.body.name : undefined;
    const filename =
      typeof req.body?.filename === "string" && req.body.filename.trim()
        ? req.body.filename.trim()
        : "playbook.docx";

    const playbook = await importPlaybookFromDocx({
      userId,
      filename,
      buffer: Buffer.from(bytes),
      name,
      model,
    });
    res.status(201).json(playbook);
  } catch (error) {
    sendError(res, error);
  } finally {
    // The import retains its own copy of the source on success, so the staged
    // object is redundant either way.
    if (staged) {
      await deleteFile(storageKey).catch((error) => {
        console.error("[playbooks] staged upload cleanup failed", {
          storageKey,
          error,
        });
      });
    }
  }
});

playbooksRouter.get("/:playbookId", async (req, res) => {
  try {
    res.json(
      await getPlaybook(res.locals.userId as string, req.params.playbookId),
    );
  } catch (error) {
    sendError(res, error);
  }
});

playbooksRouter.put("/:playbookId", requireMfaIfEnrolled, async (req, res) => {
  try {
    res.json(
      await updatePlaybookDraft(
        res.locals.userId as string,
        req.params.playbookId,
        req.body?.draft ?? req.body,
      ),
    );
  } catch (error) {
    sendError(res, error);
  }
});

playbooksRouter.post(
  "/:playbookId/publish",
  requireMfaIfEnrolled,
  async (req, res) => {
    try {
      res.json(
        await publishPlaybook(
          res.locals.userId as string,
          req.params.playbookId,
        ),
      );
    } catch (error) {
      sendError(res, error);
    }
  },
);

playbooksRouter.post("/:playbookId/review", async (req, res) => {
  try {
    const text =
      typeof req.body?.documentText === "string" ? req.body.documentText : "";
    const model = typeof req.body?.model === "string" ? req.body.model : "";
    const documentName =
      typeof req.body?.documentName === "string"
        ? req.body.documentName
        : undefined;
    const instructions =
      typeof req.body?.instructions === "string"
        ? req.body.instructions
        : undefined;
    const reviewMode =
      req.body?.reviewMode === "permissive"
        ? ("permissive" as const)
        : ("strict" as const);
    res.json(
      await reviewWithPlaybook({
        userId: res.locals.userId as string,
        playbookId: req.params.playbookId,
        documentText: text,
        documentName,
        instructions,
        model,
        reviewMode,
      }),
    );
  } catch (error) {
    sendError(res, error);
  }
});

playbooksRouter.get("/:playbookId/runs", async (req, res) => {
  try {
    res.json(
      await listPlaybookRuns(
        res.locals.userId as string,
        req.params.playbookId,
      ),
    );
  } catch (error) {
    sendError(res, error);
  }
});

playbooksRouter.delete(
  "/:playbookId",
  requireMfaIfEnrolled,
  async (req, res) => {
    try {
      await deletePlaybook(res.locals.userId as string, req.params.playbookId);
      res.status(204).send();
    } catch (error) {
      sendError(res, error);
    }
  },
);
