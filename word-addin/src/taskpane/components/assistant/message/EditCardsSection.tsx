import React, { type ReactNode } from "react";
import { EditCardsSectionUI } from "@mike/ui";
import { EDIT_SECTION_SURFACE } from "./messageStyles";

interface EditCardsSectionProps {
  summary: string;
  actions?: ReactNode;
  actionsLabel?: string;
  children: ReactNode;
}

export function EditCardsSection({
  summary,
  actions,
  actionsLabel = "Tracked change actions",
  children,
}: EditCardsSectionProps): React.ReactElement {
  return (
    <EditCardsSectionUI
      summary={summary}
      actions={actions}
      actionsLabel={actionsLabel}
      className={`${EDIT_SECTION_SURFACE} overflow-hidden`}
    >
      {children}
    </EditCardsSectionUI>
  );
}
