import crypto from "node:crypto";
import type { Session } from "@supabase/supabase-js";
import { createServerSupabase } from "./supabase";
import { authHandoffEncryptionSecret } from "./runtimeConfig";
import type { Db } from "./supabase";

const HANDOFF_TABLE = "auth_handoff_tickets";
const DEFAULT_TTL_SECONDS = 120;
const MIN_TTL_SECONDS = 30;
const MAX_TTL_SECONDS = 300;

interface StoredHandoff {
  user_id: string;
  ticket_hash: string;
  request_id: string;
  origin: string;
  encrypted_session: string;
  session_iv: string;
  session_tag: string;
}

export interface ConsumedAuthHandoff {
  userId: string;
  accessToken: string;
  refreshToken: string;
}

function encryptionKey(): Buffer {
  return crypto.scryptSync(
    authHandoffEncryptionSecret(),
    "mike-auth-handoff-v1",
    32,
  );
}

function associatedData(
  row: Pick<StoredHandoff, "user_id" | "ticket_hash" | "request_id" | "origin">,
) {
  return Buffer.from(
    [
      "mike-auth-handoff-v1",
      row.user_id,
      row.ticket_hash,
      row.request_id,
      row.origin,
    ].join("\0"),
    "utf8",
  );
}

function encryptSession(
  session: Pick<Session, "access_token" | "refresh_token">,
  context: Pick<
    StoredHandoff,
    "user_id" | "ticket_hash" | "request_id" | "origin"
  >,
) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  cipher.setAAD(associatedData(context));
  const encrypted = Buffer.concat([
    cipher.update(
      JSON.stringify({
        accessToken: session.access_token,
        refreshToken: session.refresh_token,
      }),
      "utf8",
    ),
    cipher.final(),
  ]);
  return {
    encrypted_session: encrypted.toString("base64"),
    session_iv: iv.toString("base64"),
    session_tag: cipher.getAuthTag().toString("base64"),
  };
}

function decryptSession(row: StoredHandoff): ConsumedAuthHandoff {
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    encryptionKey(),
    Buffer.from(row.session_iv, "base64"),
  );
  decipher.setAAD(associatedData(row));
  decipher.setAuthTag(Buffer.from(row.session_tag, "base64"));
  const cleartext = Buffer.concat([
    decipher.update(Buffer.from(row.encrypted_session, "base64")),
    decipher.final(),
  ]).toString("utf8");
  const parsed = JSON.parse(cleartext) as {
    accessToken?: unknown;
    refreshToken?: unknown;
  };
  if (
    typeof parsed.accessToken !== "string" ||
    !parsed.accessToken ||
    typeof parsed.refreshToken !== "string" ||
    !parsed.refreshToken
  ) {
    throw new Error("Stored authentication handoff is invalid");
  }
  return {
    userId: row.user_id,
    accessToken: parsed.accessToken,
    refreshToken: parsed.refreshToken,
  };
}

function ttlSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number.parseInt(env.AUTH_HANDOFF_TTL_SECONDS ?? "", 10);
  if (!Number.isFinite(configured)) return DEFAULT_TTL_SECONDS;
  return Math.min(MAX_TTL_SECONDS, Math.max(MIN_TTL_SECONDS, configured));
}

function ticketHash(ticket: string): string {
  return crypto.createHash("sha256").update(ticket, "utf8").digest("hex");
}

export async function issueAuthHandoff(input: {
  userId: string;
  requestId: string;
  origin: string;
  session: Session;
  db?: Db;
}): Promise<string> {
  const db = input.db ?? createServerSupabase();
  const ticket = crypto.randomBytes(32).toString("base64url");
  const hash = ticketHash(ticket);
  const context = {
    user_id: input.userId,
    ticket_hash: hash,
    request_id: input.requestId,
    origin: input.origin,
  };
  const expiresAt = new Date(Date.now() + ttlSeconds() * 1000).toISOString();
  const encrypted = encryptSession(input.session, context);

  // Keep cleanup opportunistic so issuing tickets has no scheduler dependency.
  const cleanup = await db
    .from(HANDOFF_TABLE)
    .delete()
    .lt("expires_at", new Date().toISOString());
  if (cleanup.error) {
    console.warn("[auth/handoff] expired-ticket cleanup failed", {
      code: cleanup.error.code,
    });
  }

  const { error } = await db.from(HANDOFF_TABLE).insert({
    ...context,
    ...encrypted,
    expires_at: expiresAt,
  });
  if (error) throw error;
  return ticket;
}

export async function consumeAuthHandoff(input: {
  ticket: string;
  requestId: string;
  origin: string;
  db?: Db;
}): Promise<ConsumedAuthHandoff | null> {
  const db = input.db ?? createServerSupabase();
  const consumedAt = new Date().toISOString();
  const { data, error } = await db
    .from(HANDOFF_TABLE)
    .update({ consumed_at: consumedAt })
    .eq("ticket_hash", ticketHash(input.ticket))
    .eq("request_id", input.requestId)
    .eq("origin", input.origin)
    .is("consumed_at", null)
    .gt("expires_at", consumedAt)
    .select(
      "user_id,ticket_hash,request_id,origin,encrypted_session,session_iv,session_tag",
    )
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return decryptSession(data as StoredHandoff);
}
