/// <reference types="office-js" />
/**
 * The same task pane runs in Word and in Outlook (message compose). Code that
 * touches the host's object model branches here; everything else — sign-in,
 * chat, history, workflows, playbooks, models, settings — is shared, so the
 * two clients look and behave the same.
 */
export type OfficeHostKind = "word" | "outlook";

export function officeHostKind(): OfficeHostKind {
  try {
    return Office.context?.host === Office.HostType.Outlook ? "outlook" : "word";
  } catch {
    return "word";
  }
}

export function isOutlookHost(): boolean {
  return officeHostKind() === "outlook";
}
