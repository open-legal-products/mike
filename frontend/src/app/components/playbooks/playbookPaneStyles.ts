/** Overview defines the shared pane spacing for every playbook tab. */
export const PLAYBOOK_PANE_INSET_CLASS = "px-4 md:px-5";

// Side panes share the content pane's vertical rhythm, so titles sit on one
// line across the gap. The 16px top suits the narrower side panes.
const PLAYBOOK_PANE_HEADER_RHYTHM_CLASS = "shrink-0 pb-2 pt-4";

export const PLAYBOOK_PANE_HEADER_CLASS =
  `${PLAYBOOK_PANE_INSET_CLASS} ${PLAYBOOK_PANE_HEADER_RHYTHM_CLASS}`;

export const PLAYBOOK_PANE_BODY_CLASS =
  `${PLAYBOOK_PANE_INSET_CLASS} pb-4 pt-2 md:pb-5`;

// The right inset is smaller so header icon buttons sit near the edge.
export const PLAYBOOK_SIDE_HEADER_CLASS =
  `pl-4 pr-2 md:pl-5 md:pr-3 ${PLAYBOOK_PANE_HEADER_RHYTHM_CLASS}`;

export const PLAYBOOK_SIDE_BODY_CLASS = "px-4 pb-4 pt-2 md:px-5";

// Rows already have px-2 and py-1.5, so their text lands on the header's
// inset and 8px below it, like the side body.
export const PLAYBOOK_SIDE_LIST_CLASS = "px-2 pb-2 pt-0.5 md:px-3";

export const PLAYBOOK_PANE_EMPTY_CLASS = "p-4 md:p-5";

// A main pane's title: a size above field labels and section headings, on
// their 20px line so pane headers stay level across the panes.
export const PLAYBOOK_PANE_TITLE_CLASS =
  "text-base font-medium leading-5 text-gray-900";

// The smaller title of a side pane or a document viewer.
export const PLAYBOOK_SIDE_TITLE_CLASS = "text-sm font-medium text-gray-900";
