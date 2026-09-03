// HTTP layer for the downloads module.
//
// Route handlers parse params, call the downloads.service functions, and map
// their typed results onto status codes, headers, and JSON.

import { Router } from "express";
import { requireAuth } from "../../middleware/auth";
import { createServerSupabase } from "../../lib/supabase";
import { buildContentDisposition } from "../../lib/storage";
import { resolveTokenDownload } from "./downloads.service";

export const downloadsRouter = Router();

// GET /download/:token
downloadsRouter.get("/:token", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const db = createServerSupabase();
    const result = await resolveTokenDownload(db, {
        token: req.params.token,
        userId,
        userEmail,
    });
    if (!result.ok)
        return void res.status(404).json({
            detail:
                result.kind === "invalid_link" ? "Invalid link" : "File not found",
        });

    res.setHeader("Content-Type", result.contentType);
    res.setHeader(
        "Content-Disposition",
        buildContentDisposition("attachment", result.filename),
    );
    res.send(result.bytes);
});
