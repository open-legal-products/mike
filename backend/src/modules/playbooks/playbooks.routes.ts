import crypto from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Router, type Response } from "express";
import { requireAuth, requireMfaIfEnrolled } from "../../middleware/auth";
import { sendInternalError } from "../../lib/httpError";
import { setOperation } from "../../lib/observability/sentry";
import {
  buildContentDisposition,
  createFileReadStream,
  getSignedUploadUrl,
  headFile,
  storageEnabled,
} from "../../lib/storage";
import {
  createPlaybook,
  deletePlaybook,
  getPlaybook,
  getPlaybookSource,
  getPlaybookImport,
  listRunningPlaybookImports,
  queuePlaybookImport,
  MAX_PLAYBOOK_IMPORT_BYTES,
  listPlaybookSources,
  listPlaybookPeople,
  listPlaybookShares,
  sharePlaybook,
  revokePlaybookShare,
  getPlaybookSourceFile,
  addPlaybookSourceFromUpload,
  removePlaybookObjects,
  addPlaybookSourceFromDocument,
  deletePlaybookSource,
  playbookSourceFileType,
  playbookImportPrefix,
  playbookSourceUploadPrefix,
  isStagedPlaybookImportKey,
  isStagedPlaybookSourceKey,
  MAX_PLAYBOOK_SOURCE_FILE_BYTES,
  PLAYBOOK_IMPORT_CONTENT_TYPES,
  PLAYBOOK_SOURCE_CONTENT_TYPES,
  playbookImportFileType,
  listPlaybookRuns,
  listAllPlaybookRuns,
  listPlaybookRunHistory,
  playbookRunStatuses,
  deletePlaybookRun,
  listPlaybooks,
  PlaybookImportError,
  PlaybookRequestError,
  playbookConfiguration,
  queuePlaybookReview,
  updatePlaybookContent,
} from "./playbooks.service";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const playbooksRouter = Router();
playbooksRouter.use(requireAuth);

// A malformed id reached Postgres as `uuid = 'not-a-uuid'` (22P02) and
// surfaced as a 500. An id that cannot exist is not found, before any query.
playbooksRouter.param("playbookId", (_req, res, next, value: string) => {
  if (!UUID.test(value))
    return void res.status(404).json({ detail: "Playbook not found." });
  next();
});

const UPLOAD_URL_TTL_SECONDS = 900;

// An optional body id that is present must be a string. Coercing null, a
// number or an object to "not supplied" would let it skip the uuid check below
// and change what the request does. Only an omitted id means not supplied.
function isWrongTypeBodyId(value: unknown): boolean {
  return value !== undefined && typeof value !== "string";
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
// A page of the caller's runs, as the sidebar's History lists them.
playbooksRouter.get("/runs/history", async (req, res) => {
  try {
    const limit = Number(req.query.limit);
    const before =
      typeof req.query.before === "string" &&
      Number.isFinite(Date.parse(req.query.before))
        ? req.query.before
        : undefined;
    res.json(
      await listPlaybookRunHistory(res.locals.userId as string, undefined, {
        workspace: req.query.workspace,
        email: res.locals.userEmail,
        limit: Number.isInteger(limit) ? limit : undefined,
        before,
      }),
    );
  } catch (error) {
    sendError(res, error);
  }
});

// Only small status snapshots, of the caller's own runs.
playbooksRouter.get("/runs/status", async (req, res) => {
  try {
    const ids =
      typeof req.query.ids === "string" ? req.query.ids.split(",") : [];
    if (
      ids.length === 0 ||
      ids.length > 100 ||
      ids.some((id) => !UUID.test(id))
    ) {
      return void res
        .status(400)
        .json({ detail: "Provide between 1 and 100 valid run ids." });
    }
    res.json(
      await playbookRunStatuses(res.locals.userId as string, [
        ...new Set(ids),
      ]),
    );
  } catch (error) {
    sendError(res, error);
  }
});

// One of the caller's own runs; one still running is refused.
playbooksRouter.delete("/runs/:runId", async (req, res) => {
  try {
    if (!UUID.test(req.params.runId))
      return void res.status(404).json({ detail: "Run not found." });
    await deletePlaybookRun(
      res.locals.userId as string,
      req.params.runId,
      undefined,
      res.locals.userEmail,
    );
    res.status(204).send();
  } catch (error) {
    sendError(res, error);
  }
});

// The caller's imports still compiling in the workspace, so a page opened
// after starting one can follow it to the end.
playbooksRouter.get("/imports", async (req, res) => {
  try {
    res.json(
      await listRunningPlaybookImports(
        res.locals.userId as string,
        undefined,
        req.query.workspace,
      ),
    );
  } catch (error) {
    sendError(res, error);
  }
});

playbooksRouter.get("/imports/:importId", async (req, res) => {
  try {
    if (!UUID.test(req.params.importId)) {
      return void res.status(404).json({ detail: "Import not found." });
    }
    res.json(
      await getPlaybookImport(res.locals.userId as string, req.params.importId),
    );
  } catch (error) {
    sendError(res, error);
  }
});

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
 * Hand back a presigned PUT for the source .docx or .pdf. The browser uploads straight
 * to object storage, matching how documents are uploaded, so the API never
 * buffers the file.
 */
playbooksRouter.post("/", requireMfaIfEnrolled, async (req, res) => {
  setOperation("playbooks.save");
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
        body.visibility,
        res.locals.userEmail,
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
      const fileType = playbookImportFileType(filename);
      if (!fileType) {
        return void res
          .status(400)
          .json({ detail: "Playbook import requires a .docx or .pdf file." });
      }
      if (
        !Number.isInteger(sizeBytes) ||
        sizeBytes <= 0 ||
        sizeBytes > MAX_PLAYBOOK_IMPORT_BYTES
      ) {
        return void res.status(400).json({
          detail: `The playbook must be between 1 byte and ${Math.floor(
            MAX_PLAYBOOK_IMPORT_BYTES / (1024 * 1024),
          )} MB.`,
        });
      }

      const storageKey = `${playbookImportPrefix(
        res.locals.userId as string,
      )}${crypto.randomUUID()}.${fileType}`;
      const contentType = PLAYBOOK_IMPORT_CONTENT_TYPES[fileType];
      let uploadUrl: string | null;
      try {
        uploadUrl = await getSignedUploadUrl(
          storageKey,
          contentType,
          sizeBytes,
          UPLOAD_URL_TTL_SECONDS,
        );
      } catch (error) {
        // Signing failed (credentials, endpoint): reported once with the
        // store's code, answered as the same 503 as an unconfigured store.
        return void sendInternalError(res, error, 503);
      }
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

playbooksRouter.post("/import", requireMfaIfEnrolled, async (req, res) => {
  setOperation("playbooks.import");
  const userId = res.locals.userId as string;
  // A playbookId replaces that playbook's content instead of adding a new
  // playbook. Ownership is checked inside the import.
  if (isWrongTypeBodyId(req.body?.playbookId)) {
    return void res.status(400).json({ detail: "playbookId must be a UUID" });
  }
  if (isWrongTypeBodyId(req.body?.documentId)) {
    return void res.status(400).json({ detail: "documentId must be a UUID" });
  }
  const playbookId =
    typeof req.body?.playbookId === "string" && req.body.playbookId.trim()
      ? req.body.playbookId.trim()
      : undefined;
  // Body ids are request input. A value that cannot be a uuid is a 400,
  // matching how chat and word-chat reject a malformed id, before any query.
  if (playbookId !== undefined && !UUID.test(playbookId)) {
    return void res.status(400).json({ detail: "playbookId must be a UUID" });
  }
  const model = typeof req.body?.model === "string" ? req.body.model : "";
  const name = typeof req.body?.name === "string" ? req.body.name : undefined;
  const documentId =
    typeof req.body?.documentId === "string" && req.body.documentId
      ? req.body.documentId
      : undefined;
  if (documentId !== undefined && !UUID.test(documentId)) {
    return void res.status(400).json({ detail: "documentId must be a UUID" });
  }
  // A saved document is read where it is stored; access is checked there.
  if (documentId) {
    try {
      const attempt = await queuePlaybookImport({
        userId,
        userEmail: res.locals.userEmail,
        source: { documentId },
        name,
        model,
        playbookId,
        workspace: req.body?.workspace,
      });
      // Compiling runs as a job; its row records how it ended.
      return void res.status(202).json(attempt);
    } catch (error) {
      return void sendError(res, error);
    }
  }
  const storageKey =
    typeof req.body?.storageKey === "string" ? req.body.storageKey : "";
  // True while this request owns the staged object and must remove it; the
  // import's job owns it once queued.
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
    if (stat.size > MAX_PLAYBOOK_IMPORT_BYTES) {
      return void res
        .status(400)
        .json({ detail: "The uploaded playbook is too large." });
    }

    const filename =
      typeof req.body?.filename === "string" && req.body.filename.trim()
        ? req.body.filename.trim()
        : "playbook.docx";

    const attempt = await queuePlaybookImport({
      userId,
      userEmail: res.locals.userEmail,
      source: { storageKey, filename, size: stat.size },
      name,
      model,
      playbookId,
      workspace: req.body?.workspace,
    });
    // The job reads the staged object, and removes it once it has an outcome.
    staged = false;
    res.status(202).json(attempt);
  } catch (error) {
    sendError(res, error);
  } finally {
    // Only the staged object no job will read; a reported warning, never a
    // failed response.
    if (staged) await removePlaybookObjects([storageKey], { stage: "import.cleanup" });
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

// Streams the Word or PDF file the playbook was imported from, for the Sources view.
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
    res.setHeader(
      "Content-Type",
      PLAYBOOK_IMPORT_CONTENT_TYPES[
        playbookImportFileType(source.storageKey) ?? "docx"
      ],
    );
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
      let uploadUrl: string | null;
      try {
        uploadUrl = await getSignedUploadUrl(
          storageKey,
          contentType,
          sizeBytes,
          UPLOAD_URL_TTL_SECONDS,
        );
      } catch (error) {
        // Signing failed (credentials, endpoint): reported once with the
        // store's code, answered as the same 503 as an unconfigured store.
        return void sendInternalError(res, error, 503);
      }
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
      if (isStagedPlaybookSourceKey(userId, storageKey))
        await removePlaybookObjects([storageKey], {
          ids: { playbook_id: req.params.playbookId },
        });
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
  setOperation("playbooks.save");
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
  setOperation("playbooks.review");
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
    const reviewScope =
      req.body?.reviewScope === "issues"
        ? ("issues" as const)
        : ("full" as const);
    if (isWrongTypeBodyId(req.body?.documentId)) {
      return void res.status(400).json({ detail: "documentId must be a UUID" });
    }
    const documentId =
      typeof req.body?.documentId === "string" && req.body.documentId
        ? req.body.documentId
        : undefined;
    if (documentId !== undefined && !UUID.test(documentId)) {
      return void res.status(400).json({ detail: "documentId must be a UUID" });
    }
    const run = await queuePlaybookReview({
      userId: res.locals.userId as string,
      userEmail: res.locals.userEmail,
      playbookId: req.params.playbookId,
      documentText: text,
      documentName,
      documentId,
      instructions,
      model,
      reviewMode,
      reviewScope,
    });
    // The review runs as a job and records its own outcome on the run.
    res.status(202).json(run);
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
