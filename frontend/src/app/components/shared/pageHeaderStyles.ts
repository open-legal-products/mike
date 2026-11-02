// Kept apart from PageHeader.tsx so a page can take the title's style
// without depending on the header component itself.

/**
 * The display style of a page's title, shared by a plain title (an `<h1>`
 * passed as the header's children) and the breadcrumbs, so the two are the
 * same size on every page. One step below the display headings used for
 * empty states: a page title sits beside the header's controls, and at their
 * size it crowded them.
 */
export const PAGE_HEADER_TITLE_CLASS = "font-serif text-xl font-medium";

/**
 * The height and padding of the row a page's title sits in, which is what
 * puts the title on the same line as the sidebar's logo text. Beside the
 * sidebar (md and up) that row is 44px tall and starts 12px down plus the
 * sidebar's 1px border, so the 44px of content here starts 13px down, not
 * 12.
 */
export const PAGE_HEADER_ROW_CLASS =
    "min-h-[76px] pb-5 pt-3 md:pb-[19px] md:pt-[13px]";
