/**
 * Getting a failure from the task pane to a human.
 *
 * "Contact support" used to be a `mailto:` ANCHOR, which desktop Word simply
 * refuses to follow: the user clicked it, nothing happened, and the request
 * id they needed only ever existed inside the draft that never opened.
 *
 * The destination is still the support mailbox — the web app's /support form
 * has no backend route behind it — but it is reached the two ways that work
 * from inside the webview: the diagnostics go on the clipboard, and the
 * pre-filled draft is opened through Office's sanctioned escape hatch. Either
 * step can be refused by the host, so each is attempted independently and the
 * user is told what actually happened; when both fail the block is put on
 * screen to copy by hand.
 */
import { SUPPORT_EMAIL, supportPageContext, type UserFacingError } from "@mike/user-error";

export type SupportErrorFields = Pick<
  UserFacingError,
  "title" | "message" | "kind" | "status" | "code" | "requestId"
>;

export interface SupportContext {
  /** Where it happened: a screen name or the pane URL. */
  page?: string;
  /** Free text from the call site, e.g. which document. */
  note?: string;
  /** Which client. */
  product?: string;
  when?: Date;
  /** Injected in tests; defaults to `navigator.userAgent` when present. */
  userAgent?: string;
}

/** Both steps worked: the draft is open and the block is on the clipboard. */
export const SUPPORT_DRAFT_AND_CLIPBOARD_MESSAGE =
  "Email draft opened — the details are also on your clipboard";

/** The draft opened, but the clipboard was refused. */
export const SUPPORT_DRAFT_MESSAGE = "Email draft opened";

/**
 * The block the user pastes into the support form. Pure and fully
 * parameterised so the exact text can be asserted.
 */
export function buildSupportDiagnostics(
  error: SupportErrorFields,
  context: SupportContext = {},
): string {
  const when = context.when ?? new Date();
  const userAgent =
    context.userAgent ??
    (typeof navigator !== "undefined" ? navigator.userAgent : undefined);
  const lines: string[] = [
    "Mike support details",
    `What happened: ${error.title}`,
    `Message shown: ${error.message}`,
  ];
  if (context.note) lines.push(`Details: ${context.note}`);
  if (error.requestId) lines.push(`Request ID: ${error.requestId}`);
  if (error.code) lines.push(`Error code: ${error.code}`);
  if (error.status !== null) lines.push(`HTTP status: ${error.status}`);
  lines.push(`Category: ${error.kind}`);
  if (context.page) lines.push(`Page: ${supportPageContext(context.page)}`);
  if (context.product) lines.push(`Client: ${context.product}`);
  lines.push(`Time: ${when.toISOString()}`);
  if (userAgent) lines.push(`Browser: ${userAgent}`);
  return lines.join("\n");
}

export interface SupportHandoffResult {
  tone: "success" | "info";
  message: string;
  /**
   * Present only when neither the draft nor the clipboard worked: the block
   * goes on screen so the user can select and copy it by hand.
   */
  details?: string;
}

/**
 * What to tell the user after trying the clipboard and the mail draft.
 *
 * There is no dead end: even with both refused they are told the address and
 * shown exactly what to send. Nothing here is an error — the failure they
 * came from was already reported; this is the hand-off.
 */
export function supportHandoffResult(args: {
  copied: boolean;
  opened: boolean;
  /** The diagnostics, surfaced only on the both-refused path. */
  details: string;
}): SupportHandoffResult {
  if (args.opened) {
    return args.copied
      ? { tone: "success", message: SUPPORT_DRAFT_AND_CLIPBOARD_MESSAGE }
      : { tone: "success", message: SUPPORT_DRAFT_MESSAGE };
  }
  if (args.copied) {
    return {
      tone: "info",
      message: `Email ${SUPPORT_EMAIL} — the details are on your clipboard`,
    };
  }
  return {
    tone: "info",
    message: `Email ${SUPPORT_EMAIL}`,
    details: args.details,
  };
}

export { SUPPORT_EMAIL };
