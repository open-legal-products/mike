// Kept apart from PageHeader.tsx so a page can take the title's style
// without depending on the header component itself.

/**
 * The display style of a page's title, shared by a plain title (an `<h1>`
 * passed as the header's children) and the breadcrumbs, so the two are the
 * same size on every page, and the size of the sidebar's workspace name.
 * Below the display headings used for empty states: a page title sits beside
 * the header's controls, and at their size it crowded them.
 */
export const PAGE_HEADER_TITLE_CLASS = "font-serif text-lg font-medium";

/**
 * The row on a page sheet, the mirror of the sidebar's header beside it. Both
 * panels start 12px down plus a 1px border; this 40px row and the sidebar's
 * 28px header inside its 6px padding both have their middle 20px further
 * down, so the title sits on the logo text's line. The title is 12px in, as
 * the logo is; the 28px buttons sit 6px from the sheet's top and right edges,
 * as the sidebar's toggle does from its own (2px of margin plus the group's
 * 4px padding).
 */
export const PAGE_HEADER_SHEET_ROW_CLASS = "h-10 shrink-0 ml-3 mr-0.5";

/**
 * The height and padding of the row a page's title sits in, which is what
 * puts the title on the same line as the sidebar's logo text. Beside the
 * sidebar (md and up) that row is 40px tall and starts 12px down plus the
 * sidebar's 1px border, so its middle is 33px down. The 44px of content here
 * starts 11px down to put its middle there too.
 */
export const PAGE_HEADER_ROW_CLASS =
    "min-h-[76px] pb-5 pt-3 md:pb-[21px] md:pt-[11px]";
