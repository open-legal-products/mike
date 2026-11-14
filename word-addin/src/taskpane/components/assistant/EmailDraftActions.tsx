import React, { useState } from "react";
import { PillButtonUI as PillButton } from "@mike/ui";
import { insertIntoEmail, type EmailInsertPosition } from "../../lib/outlookCompose";
import { notifyError } from "../../lib/notify";

/**
 * Outlook only: the actions under a text card. Mirrors the Word edit cards'
 * blue/white pill pair — the primary action puts the draft where the cursor
 * is, the secondary one above the quoted thread. Nothing is ever sent.
 */
export function EmailDraftActions({ text }: { text: string }): React.ReactElement {
  const [busy, setBusy] = useState<EmailInsertPosition | null>(null);
  const [inserted, setInserted] = useState(false);

  const insert = async (position: EmailInsertPosition): Promise<void> => {
    setBusy(position);
    try {
      await insertIntoEmail(text, position);
      setInserted(true);
    } catch (error) {
      notifyError(error, { action: "insert the draft into the email" });
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <PillButton
        tone="blue"
        loading={busy === "cursor"}
        disabled={busy !== null}
        onClick={() => void insert("cursor")}
      >
        Insert into email
      </PillButton>
      <PillButton
        tone="white"
        loading={busy === "top"}
        disabled={busy !== null}
        onClick={() => void insert("top")}
      >
        Insert at top
      </PillButton>
      <span role="status" className="text-xs text-gray-500">
        {inserted ? "Inserted. Review it before sending." : ""}
      </span>
    </>
  );
}
