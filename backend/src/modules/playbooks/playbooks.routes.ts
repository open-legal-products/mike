import crypto from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Router, type Response } from "express";
import { requireAuth, requireMfaIfEnrolled } from "../../middleware/auth";
import { sendInternalError } from "../../lib/httpError";
import { safeError } from "../../lib/safeError";
import {
  buildContentDisposition,
  createFileReadStream,
  deleteFile,
  downloadFile,
  getSignedUploadUrl,
  headFile,
  storageEnabled,
} from "../../lib/storage";
import {
  createPlaybook,
  deletePlaybook,
  getPlaybook,
  getPlaybookSource,
  importPlaybookFromDocx,
  listPlaybookSources,
  listPlaybookPeople,
  listPlaybookShares,
  sharePlaybook,
  revokePlaybookShare,
  getPlaybookSourceFile,
  addPlaybookSourceFromUpload,
  addPlaybookSourceFromDocument,
  deletePlaybookSource,
  playbookSourceFileType,
  playbookImportPrefix,
  playbookSourceUploadPrefix,
  isStagedPlaybookImportKey,
  isStagedPlaybookSourceKey,
  MAX_PLAYBOOK_SOURCE_FILE_BYTES,
  PLAYBOOK_SOURCE_CONTENT_TYPES,
  listPlaybookRuns,
  listAllPlaybookRuns,
  listPlaybooks,
  PlaybookImportError,
  PlaybookRequestError,
  playbookConfiguration,
  reviewWithPlaybook,
  updatePlaybookContent,
} from "./playbooks.service";

export const playbooksRouter = Router();
playbooksRouter.use(requireAuth);

const DOCX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
/** Word playbooks are prose; anything this large is not one. */
const MAX_PLAYBOOK_SOURCE_BYTES = 25 * 1024 * 1024;
const UPLOAD_URL_TTL_SECONDS = 900;

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

playbooksRouter.get("/configuration", async (req, res) => {
  try {
    res.json(
      await playbookConfiguration(
        res.locals.userId as string,
        undefined,
        req.query.workspace,
      ),
    );
  } catch (error) {
    sendError(res, error);
  }
});

playbooksRouter.get("/", async (req, res) => {
  try {
    res.json(
      await listPlaybooks(res.locals.userId as string, undefined, {
        workspace: req.query.workspace,
        email: res.locals.userEmail,
      }),
    );
  } catch (error) {
    sendError(res, error);
  }
});

// Registered before "/:playbookId", which would otherwise match "runs".
playbooksRouter.get("/runs", async (req, res) => {
  try {
    res.json(
      await listAllPlaybookRuns(res.locals.userId as string, undefined, {
        workspace: req.query.workspace,
        email: res.locals.userEmail,
      }),
    );
  } catch (error) {
    sendError(res, error);
  }
});

/**
 * Hand back a presigned PUT for the source .docx. The browser uploads straight
 * to object storage, matching how documents are uploaded, so the API never
 * buffers the file.
 */
playbooksRouter.post("/", requireMfaIfEnrolled, async (req, res) => {
  try {
    const body = req.body ?? {};
    res.status(201).json(
      await createPlaybook(
        res.locals.userId as string,
        {
          name: typeof body.name === "string" ? body.name : undefined,
          description: body.description,
          representedParty: body.representedParty,
          documentTypes: body.documentTypes,
          jurisdictions: body.jurisdictions,
        },
        undefined,
        body.workspace,
      ),
    );
  } catch (error) {
    sendError(res, error);
  }
});

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

      const storageKey = `${playbookImportPrefix(
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
    // Only a key minted for this caller: not another account's staged
    // object, nor anything else in storage (see playbooks.staging.ts).
    if (!isStagedPlaybookImportKey(userId, storageKey)) {
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

    // A playbookId replaces that playbook's content instead of adding a new
    // playbook. Ownership is checked inside the import.
    const playbookId =
      typeof req.body?.playbookId === "string" && req.body.playbookId.trim()
        ? req.body.playbookId.trim()
        : undefined;

    const playbook = await importPlaybookFromDocx({
      userId,
      userEmail: res.locals.userEmail,
      filename,
      buffer: Buffer.from(bytes),
      name,
      model,
      playbookId,
      workspace: req.body?.workspace,
    });
    res.status(playbookId ? 200 : 201).json(playbook);
  } catch (error) {
    sendError(res, error);
  } finally {
    // The import retains its own copy of the source on success, so the staged
    // object is redundant either way.
    if (staged) {
      await deleteFile(storageKey).catch((error) => {
        console.error("[playbooks] staged upload cleanup failed", {
          storageKey,
          error: safeError(error),
        });
      });
    }
  }
});

playbooksRouter.get("/:playbookId", async (req, res) => {
  try {
    res.json(
      await getPlaybook(
        res.locals.userId as string,
        req.params.playbookId,
        undefined,
        res.locals.userEmail,
      ),
    );
  } catch (error) {
    sendError(res, error);
  }
});

// Streams the Word file the playbook was imported from, for the Sources view.
// Proxying keeps viewers off cross-origin signed storage URLs, as for
// documents; the stream is opened here so `res` applies backpressure.
playbooksRouter.get("/:playbookId/source", async (req, res) => {
  try {
    const source = await getPlaybookSource(
      res.locals.userId as string,
      req.params.playbookId,
      undefined,
      res.locals.userEmail,
    );
    const stat = source ? await headFile(source.storageKey) : null;
    if (!source || !stat) {
      return void res
        .status(404)
        .json({ detail: "This playbook has no source document." });
    }
    res.setHeader("Content-Type", DOCX_CONTENT_TYPE);
    res.setHeader("Content-Length", stat.size);
    res.setHeader(
      "Content-Disposition",
      buildContentDisposition("inline", source.filename),
    );
    const stream = createFileReadStream(source.storageKey);
    try {
      await pipeline(stream, res);
    } catch (error) {
      stream.destroy();
      if (!res.headersSent && !res.destroyed) sendInternalError(res, error);
    }
  } catch (error) {
    sendError(res, error);
  }
});

// The access roster any viewer may read, in the shape of /workflows/:id/people.
playbooksRouter.get("/:playbookId/people", async (req, res) => {
  try {
    res.json(
      await listPlaybookPeople(
        res.locals.userId as string,
        res.locals.userEmail,
        req.params.playbookId,
      ),
    );
  } catch (error) {
    sendError(res, error);
  }
});

playbooksRouter.get("/:playbookId/shares", async (req, res) => {
  try {
    res.json(
      await listPlaybookShares(
        res.locals.userId as string,
        res.locals.userEmail,
        req.params.playbookId,
      ),
    );
  } catch (error) {
    sendError(res, error);
  }
});

playbooksRouter.post(
  "/:playbookId/share",
  requireMfaIfEnrolled,
  async (req, res) => {
    try {
      await sharePlaybook(
        res.locals.userId as string,
        res.locals.userEmail,
        req.params.playbookId,
        { emails: req.body?.emails, role: req.body?.role },
      );
      res.status(204).send();
    } catch (error) {
      sendError(res, error);
    }
  },
);

playbooksRouter.delete(
  "/:playbookId/shares/:shareId",
  requireMfaIfEnrolled,
  async (req, res) => {
    try {
      await revokePlaybookShare(
        res.locals.userId as string,
        res.locals.userEmail,
        req.params.playbookId,
        req.params.shareId,
      );
      res.status(204).send();
    } catch (error) {
      sendError(res, error);
    }
  },
);

playbooksRouter.get("/:playbookId/sources", async (req, res) => {
  try {
    res.json(
      await listPlaybookSources(
        res.locals.userId as string,
        req.params.playbookId,
        undefined,
        res.locals.userEmail,
      ),
    );
  } catch (error) {
    sendError(res, error);
  }
});

/** A presigned PUT for a supplementary document, staged under the caller. */
playbooksRouter.post(
  "/:playbookId/sources/upload-url",
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
      const fileType = playbookSourceFileType(filename);
      if (!fileType) {
        return void res
          .status(400)
          .json({ detail: "Add a .docx or .pdf file." });
      }
      if (
        !Number.isInteger(sizeBytes) ||
        sizeBytes <= 0 ||
        sizeBytes > MAX_PLAYBOOK_SOURCE_FILE_BYTES
      ) {
        return void res.status(400).json({
          detail: `Supplementary documents must be between 1 byte and ${Math.floor(
            MAX_PLAYBOOK_SOURCE_FILE_BYTES / (1024 * 1024),
          )} MB.`,
        });
      }
      const contentType = PLAYBOOK_SOURCE_CONTENT_TYPES[fileType];
      const storageKey = `${playbookSourceUploadPrefix(
        res.locals.userId as string,
      )}${crypto.randomUUID()}.${fileType}`;
      const uploadUrl = await getSignedUploadUrl(
        storageKey,
        contentType,
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
        contentType,
        expiresInSeconds: UPLOAD_URL_TTL_SECONDS,
      });
    } catch (error) {
      sendError(res, error);
    }
  },
);

// Adds a copy of either a staged upload ({storageKey, filename}) or a
// document the caller can open ({documentId}).
playbooksRouter.post(
  "/:playbookId/sources",
  requireMfaIfEnrolled,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const storageKey =
      typeof req.body?.storageKey === "string" ? req.body.storageKey : "";
    const documentId =
      typeof req.body?.documentId === "string" ? req.body.documentId.trim() : "";
    try {
      if (documentId) {
        return void res
          .status(201)
          .json(
            await addPlaybookSourceFromDocument(
              userId,
              res.locals.userEmail,
              req.params.playbookId,
              documentId,
            ),
          );
      }
      if (!storageKey) {
        return void res
          .status(400)
          .json({ detail: "Choose a document to add." });
      }
      res.status(201).json(
        await addPlaybookSourceFromUpload(
          userId,
          res.locals.userEmail,
          req.params.playbookId,
          {
          storageKey,
            filename:
              typeof req.body?.filename === "string" ? req.body.filename : "",
          },
        ),
      );
    } catch (error) {
      sendError(res, error);
    } finally {
      // The playbook keeps its own copy, so the staged object is redundant
      // whatever happened. Only a key minted for this caller is ever touched.
      if (isStagedPlaybookSourceKey(userId, storageKey)) {
        await deleteFile(storageKey).catch((error) => {
          console.error("[playbooks] staged source cleanup failed", {
            storageKey,
            error: safeError(error),
          });
        });
      }
    }
  },
);

playbooksRouter.get("/:playbookId/sources/:sourceId/file", async (req, res) => {
  try {
    const source = await getPlaybookSourceFile(
      res.locals.userId as string,
      req.params.playbookId,
      req.params.sourceId,
      undefined,
      res.locals.userEmail,
    );
    const stat = source ? await headFile(source.storageKey) : null;
    if (!source || !stat) {
      return void res
        .status(404)
        .json({ detail: "Source document not found." });
    }
    res.setHeader("Content-Type", source.contentType);
    res.setHeader("Content-Length", stat.size);
    res.setHeader(
      "Content-Disposition",
      buildContentDisposition("inline", source.filename),
    );
    const stream = createFileReadStream(source.storageKey);
    try {
      await pipeline(stream, res);
    } catch (error) {
      stream.destroy();
      if (!res.headersSent && !res.destroyed) sendInternalError(res, error);
    }
  } catch (error) {
    sendError(res, error);
  }
});

playbooksRouter.delete(
  "/:playbookId/sources/:sourceId",
  requireMfaIfEnrolled,
  async (req, res) => {
    try {
      await deletePlaybookSource(
        res.locals.userId as string,
        res.locals.userEmail,
        req.params.playbookId,
        req.params.sourceId,
      );
      res.status(204).send();
    } catch (error) {
      sendError(res, error);
    }
  },
);

playbooksRouter.put("/:playbookId", requireMfaIfEnrolled, async (req, res) => {
  try {
    res.json(
      await updatePlaybookContent(
        res.locals.userId as string,
        req.params.playbookId,
        req.body?.content ?? req.body,
        undefined,
        // Sharing has its own routes below; only visibility rides along.
        { visibility: req.body?.visibility },
        res.locals.userEmail,
      ),
    );
  } catch (error) {
    sendError(res, error);
  }
});

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
        userEmail: res.locals.userEmail,
        playbookId: req.params.playbookId,
        documentText: text,
        documentName,
        documentId:
          typeof req.body?.documentId === "string" && req.body.documentId
            ? req.body.documentId
            : undefined,
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
        undefined,
        res.locals.userEmail,
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
      await deletePlaybook(
        res.locals.userId as string,
        req.params.playbookId,
        undefined,
        res.locals.userEmail,
      );
      res.status(204).send();
    } catch (error) {
      sendError(res, error);
    }
  },
);
