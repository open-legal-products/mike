/** Overview defines the shared pane spacing for every playbook tab. */
export const PLAYBOOK_PANE_INSET_CLASS = "px-4 md:px-5";

export const PLAYBOOK_PANE_HEADER_CLASS =
  `${PLAYBOOK_PANE_INSET_CLASS} shrink-0 pb-2 pt-4 md:pt-5`;

export const PLAYBOOK_PANE_BODY_CLASS =
  `${PLAYBOOK_PANE_INSET_CLASS} pb-4 pt-2 md:pb-5`;

// Rows already have px-2 and py-1.5. Compensate so their content starts at
// the same side inset and 8px below the header as Overview's fields.
export const PLAYBOOK_PANE_LIST_CLASS =
  "px-2 pb-4 pt-0.5 md:px-3 md:pb-5";

export const PLAYBOOK_PANE_EMPTY_CLASS = "p-4 md:p-5";
