// Reads a composed visual as document blocks for Word: text in document
// order, tables as tables, and anything drawn (charts, graphs, tracks, SVG,
// custom graphics) as a picture of that element alone.
import type { Locator, Page } from "playwright-core";
import type { Run, VisualBlock, VisualText } from "./types";

export const BLOCKS_PAGE_WIDTH = 640;
const MAX_IMAGES = 24;
const MAX_IMAGE_HEIGHT_PX = 2000;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const SHOT_TIMEOUT_MS = 5000;

type TextBlock = Exclude<VisualBlock, { type: "image" }>;
type PageBlock = TextBlock | { type: "image"; shot: number; alt: string; fallback: TextBlock[] };

/** Runs inside the page, so it can only use what the browser has. */
function readBlocks(): PageBlock[] {
    const blocks: PageBlock[] = [];
    let shots = 0;
    const SKIP = [
        "script", "style", "template", "noscript", '[aria-hidden="true"]', ".mv-cite", ".mv-sr", ".mv-sr-only",
        ".mv-chart-data", ".mv-tabs-list", ".mv-tooltip", ".mv-findings-n", ".mv-header .mv-eyebrow", ".mv-section-num",
    ].join(", ");
    const SMALL = ".mv-subtitle, .mv-section-meta, .mv-chart-sub, .mv-caption, .mv-table-caption, .mv-stat-note, #mv-snapshot";
    // A container drawn from plain painted boxes is taken whole; one that
    // holds something readable is read block by block instead.
    const DRAWN = '.mv-panel, figure, [role="figure"], [role="list"][aria-label]';
    const READABLE = 'table, [role="table"], .mv-chart-fig, .mv-stats, .mv-timeline, svg';
    const hidden = (el: Element) => {
        const style = getComputedStyle(el);
        return style.display === "none" || style.visibility === "hidden";
    };
    const skip = (el: Element) => el.matches(SKIP) || hidden(el);
    const isBlock = (el: Element) => !/^inline/.test(getComputedStyle(el).display);
    const small = (el: Element) => !!el.closest(SMALL);
    const isList = (el: Element) => el.tagName === "UL" || el.tagName === "OL";
    const isGraphic = (el: Element) =>
        /^(svg|canvas|img|video)$/i.test(el.tagName) || el.getAttribute("role") === "img" || el.matches(".mv-graph, .mv-tracks");
    const NUMERIC = /^[-−+(]?\s*[£$€]?\s*\d[\d,.]*\s*(?:%|bn|m|k|x)?\)?$/i;

    type Flags = Omit<Run, "text">;
    const flat = (value: VisualText) => (typeof value === "string" ? value : value.map((run) => run.text).join(""));
    const sameFlags = (a: Flags, b: Flags) => !!a.strike === !!b.strike && !!a.underline === !!b.underline && !!a.bold === !!b.bold;
    const flagsOf = (el: Element, inherited: Flags): Flags => ({
        ...inherited,
        ...(/^(DEL|S)$/.test(el.tagName) ? { strike: true as const } : {}),
        ...(/^(INS|U)$/.test(el.tagName) ? { underline: true as const } : {}),
        ...(/^(B|STRONG)$/.test(el.tagName) ? { bold: true as const } : {}),
    });

    // Text runs with block boundaries as newlines; nested lists are left to
    // the list walker.
    function runs(el: Node, exclude?: (child: Element) => boolean, flags: Flags = {}, out: Run[] = []): Run[] {
        const push = (text: string, own: Flags) => {
            if (!text) return;
            const last = out[out.length - 1];
            if (last && sameFlags(last, own)) last.text += text;
            else out.push({ text, ...own });
        };
        for (const node of Array.from(el.childNodes)) {
            if (node.nodeType === Node.TEXT_NODE) push(node.nodeValue ?? "", flags);
            if (node.nodeType !== Node.ELEMENT_NODE) continue;
            const child = node as Element;
            if (skip(child) || exclude?.(child) || isGraphic(child)) continue;
            if (child.tagName === "BR") {
                push("\n", flags);
                continue;
            }
            const block = isBlock(child);
            if (block) push("\n", flags);
            runs(child, exclude, flagsOf(child, flags), out);
            if (block) push("\n", flags);
        }
        return out;
    }

    // Folds whitespace the way the page shows it; a skipped cite must not
    // leave a gap before the punctuation that followed it.
    function clean(parts: Run[], multiline: boolean): VisualText {
        const out: Run[] = [];
        for (const part of parts) {
            let text = part.text.replace(multiline ? /[^\S\n]+/g : /\s+/g, " ");
            if (multiline) text = text.replace(/ *\n\s*/g, "\n");
            const prev = out[out.length - 1];
            if (!prev) text = text.replace(/^\s+/, "");
            else if (/\s$/.test(prev.text)) text = text.replace(/^ +/, "");
            if (prev && /^[\n.,;:!?)\]]/.test(text)) {
                prev.text = prev.text.replace(/ +$/, "");
                if (!prev.text) out.pop();
            }
            text = text.replace(/\s+([.,;:!?)\]])/g, "$1");
            if (!text) continue;
            const last = out[out.length - 1];
            if (last && sameFlags(last, part)) last.text += text;
            else out.push({ ...part, text });
        }
        while (out.length) {
            const last = out[out.length - 1];
            last.text = last.text.replace(/\s+$/, "");
            if (last.text) break;
            out.pop();
        }
        return out.some((run) => run.strike || run.underline || run.bold) ? out : out.map((run) => run.text).join("");
    }
    const line = (el: Node, exclude?: (child: Element) => boolean) => clean(runs(el, exclude), false);
    const lines = (el: Node, exclude?: (child: Element) => boolean) => clean(runs(el, exclude), true);
    const plain = (el: Node, exclude?: (child: Element) => boolean) => flat(line(el, exclude));

    const paragraph = (text: VisualText, opts: { bullet?: number; style?: "small" | "caption" } = {}, into: PageBlock[] = blocks) => {
        if (!text.length) return;
        into.push({
            type: "paragraph",
            text,
            ...(opts.bullet === undefined ? {} : { bullet: opts.bullet }),
            ...(opts.style ? { style: opts.style } : {}),
        });
    };
    const heading = (level: 1 | 2 | 3, text: string) => {
        if (text) blocks.push({ type: "heading", level, text });
    };
    const altFor = (el: Element) =>
        el.getAttribute("aria-label") ||
        el.querySelector("[aria-label]:not(button)")?.getAttribute("aria-label") ||
        el.querySelector("title")?.textContent?.trim() ||
        blocks.filter((block) => block.type === "heading").pop()?.text ||
        "Figure";

    function image(el: Element, alt: string, fallback: TextBlock[] = [{ type: "paragraph", text: alt, style: "small" }]) {
        const rect = el.getBoundingClientRect();
        if (rect.width < 1 || rect.height < 1) return;
        el.setAttribute("data-mv-shot", String(shots));
        blocks.push({ type: "image", shot: shots++, alt, fallback });
    }

    const painted = (el: Element) => {
        if (el.textContent?.trim()) return false;
        const style = getComputedStyle(el);
        const transparent = style.backgroundColor === "rgba(0, 0, 0, 0)" || style.backgroundColor === "transparent";
        if (transparent && style.backgroundImage === "none") return false;
        const rect = el.getBoundingClientRect();
        return rect.width >= 4 && rect.height >= 4;
    };
    const drawn = (el: Element) => {
        if (!el.matches(DRAWN) || el.querySelector(READABLE)) return false;
        let boxes = 0;
        for (const child of Array.from(el.querySelectorAll("*"))) if (painted(child) && ++boxes >= 2) return true;
        return false;
    };

    function table(rows: VisualText[][], header: boolean, numericClass: (row: number, col: number) => boolean, into: PageBlock[] = blocks) {
        const cols = Math.max(0, ...rows.map((row) => row.length));
        if (!cols) return;
        const body = rows.map((row, index) => ({ row, index })).slice(header ? 1 : 0).filter(({ row }) => row.length);
        const numeric = Array.from({ length: cols }, (_, col) => {
            if (body.some(({ index }) => numericClass(index, col))) return true;
            const values = body.map(({ row }) => flat(row[col] ?? "")).filter(Boolean);
            return values.length > 0 && values.every((value) => NUMERIC.test(value));
        });
        into.push({
            type: "table",
            rows: rows.filter((row) => row.length).map((row) => row.concat(Array(cols - row.length).fill(""))),
            header,
            numeric,
        });
    }

    function htmlTable(el: HTMLTableElement, into: PageBlock[] = blocks) {
        const trs = Array.from(el.querySelectorAll("tr")).filter((tr) => tr.closest("table") === el && !hidden(tr));
        // A spanning cell is followed by blank cells so the columns line up.
        const cellsOf = (tr: Element) =>
            Array.from(tr.children)
                .filter((c): c is HTMLTableCellElement => /^(TD|TH)$/.test(c.tagName) && !hidden(c))
                .flatMap((cell) => [cell, ...Array<null>(Math.max(0, cell.colSpan - 1)).fill(null)]);
        const header = trs.length > 0 && (!!trs[0].closest("thead") || cellsOf(trs[0]).every((c) => c === null || c.tagName === "TH"));
        table(
            trs.map((tr) => cellsOf(tr).map((cell) => (cell ? lines(cell) : ""))),
            header,
            (row, col) => !!cellsOf(trs[row])[col]?.classList.contains("mv-cell-num"),
            into,
        );
        const caption = el.querySelector("caption");
        if (caption && !skip(caption)) paragraph(line(caption), { style: "small" }, into);
    }

    function roleTable(el: Element) {
        const trs = Array.from(el.querySelectorAll('[role="row"]')).filter((tr) => tr.closest('[role="table"]') === el && !hidden(tr));
        const cellsOf = (tr: Element) =>
            Array.from(tr.querySelectorAll('[role="cell"], [role="gridcell"], [role="columnheader"], [role="rowheader"]')).filter(
                (c) => c.closest('[role="row"]') === tr && !hidden(c),
            );
        const header = trs.length > 0 && cellsOf(trs[0]).every((c) => c.getAttribute("role") === "columnheader");
        table(
            trs.map((tr) => cellsOf(tr).map((cell) => lines(cell))),
            header,
            (row, col) => !!cellsOf(trs[row])[col]?.matches(".mv-cell-num, .mv-num"),
        );
    }

    function stats(el: Element) {
        const tiles = Array.from(el.querySelectorAll(".mv-stat")).filter((tile) => !hidden(tile));
        const part = (tile: Element, selector: string) => {
            const found = tile.querySelector(selector);
            return found ? plain(found) : "";
        };
        const notes = tiles.map((tile) => part(tile, ".mv-stat-note"));
        const rows = tiles.map((tile, i) => {
            const value = part(tile, ".mv-stat-value");
            const row: VisualText[] = [part(tile, ".mv-stat-label"), value ? [{ text: value, bold: true }] : ""];
            if (notes.some(Boolean)) row.push(notes[i]);
            return row;
        });
        table(rows, false, () => false);
    }

    function timeline(el: Element) {
        const rows: VisualText[][] = [["Date", "Event", "Status"]];
        for (const item of Array.from(el.querySelectorAll(".mv-tl-item"))) {
            if (hidden(item)) continue;
            const part = (selector: string, exclude?: (child: Element) => boolean) => {
                const found = item.querySelector(selector);
                return found ? lines(found, exclude) : "";
            };
            rows.push([part(".mv-tl-date"), part(".mv-tl-body", (child) => child.classList.contains("mv-tl-status")), part(".mv-tl-status")]);
        }
        table(rows, true, () => false);
    }

    function note(el: Element) {
        const label = el.querySelector(".mv-note-label");
        const lead: Run[] = label && plain(label) ? [{ text: plain(label).replace(/[.:]?$/, ". "), bold: true }] : [];
        const body = runs(el, (child) => child === label);
        if (body.length) body[0].text = body[0].text.replace(/^\s+/, "");
        paragraph(clean([...lead, ...body], true));
    }

    function list(el: Element, depth: number) {
        const ordered = el.tagName === "OL";
        let n = 0;
        for (const li of Array.from(el.children)) {
            if (li.tagName !== "LI" || skip(li)) continue;
            n++;
            const own = line(li, isList);
            if (ordered) paragraph(typeof own === "string" ? `${n}. ${own}` : [{ text: `${n}. ` }, ...own]);
            else paragraph(own, { bullet: depth });
            for (const nested of Array.from(li.children)) if (isList(nested) && !skip(nested)) list(nested, depth + 1);
        }
    }

    function walkChildren(el: Element) {
        let buffer: Run[] = [];
        const flush = () => {
            paragraph(clean(buffer, false), { style: small(el) ? "small" : undefined });
            buffer = [];
        };
        for (const node of Array.from(el.childNodes)) {
            if (node.nodeType === Node.TEXT_NODE) buffer.push({ text: node.nodeValue ?? "" });
            if (node.nodeType !== Node.ELEMENT_NODE) continue;
            const child = node as Element;
            if (skip(child)) continue;
            const block = isBlock(child);
            // An icon drawn inside a line of text is not a figure.
            if (isGraphic(child) && !block && child.getBoundingClientRect().height < 32) continue;
            if (block || isGraphic(child)) {
                flush();
                walk(child);
            } else runs(child, undefined, flagsOf(child, {}), buffer);
        }
        flush();
    }

    function walk(el: Element) {
        if (skip(el)) return;
        const tag = el.tagName.toLowerCase();
        const cls = el.classList;
        if (drawn(el)) return image(el, altFor(el));
        if (el.id === "mv-snapshot") return paragraph(line(el), { style: "small" });
        if (/^h[1-6]$/.test(tag)) return heading(tag === "h1" ? 1 : tag === "h2" ? 2 : 3, plain(el));
        if (cls.contains("mv-section-head")) {
            const title = el.querySelector(".mv-section-title");
            if (title) heading(2, plain(title));
            const meta = el.querySelector(".mv-section-meta");
            if (meta) paragraph(line(meta), { style: "small" });
            return;
        }
        if (cls.contains("mv-tab")) {
            heading(2, (el as HTMLElement).dataset.tab ?? "");
            return walkChildren(el);
        }
        if (cls.contains("mv-chart-fig")) {
            const title = el.querySelector(".mv-chart-title");
            const sub = el.querySelector(".mv-chart-sub");
            if (title) paragraph(line(title), { style: "caption" });
            if (sub) paragraph(line(sub), { style: "small" });
            const data = el.querySelector<HTMLTableElement>(".mv-chart-data table");
            const fallback: TextBlock[] = [];
            if (data) htmlTable(data, fallback);
            const alt = el.querySelector(".mv-chart-plot")?.getAttribute("aria-label") || (title && plain(title)) || "Chart";
            return image(el, alt, fallback.length ? fallback : undefined);
        }
        if (cls.contains("mv-timeline")) return timeline(el);
        if (isGraphic(el)) return image(el, altFor(el));
        if (tag === "table") return htmlTable(el as HTMLTableElement);
        if (el.getAttribute("role") === "table") return roleTable(el);
        if (cls.contains("mv-stats")) return stats(el);
        if (cls.contains("mv-note")) return note(el);
        if (isList(el)) return list(el, 0);
        if (tag === "dl") {
            const rows: VisualText[][] = [];
            for (const child of Array.from(el.children)) {
                if (skip(child)) continue;
                if (child.tagName === "DT" || !rows.length) rows.push([lines(child)]);
                else rows[rows.length - 1].push(lines(child));
            }
            return table(rows, false, () => false);
        }
        if (Array.from(el.children).some((child) => !skip(child) && (isBlock(child) || isGraphic(child)))) return walkChildren(el);
        paragraph(line(el), { style: small(el) ? "small" : undefined });
    }

    walkChildren(document.body);
    // A chart's title and subtitle are already text blocks; the picture is
    // the legend and the plot.
    const style = document.createElement("style");
    style.textContent = "[data-mv-shot].mv-chart-fig .mv-chart-head, [data-mv-shot].mv-chart-fig .mv-chart-data { display: none !important; }";
    document.head.appendChild(style);
    return blocks;
}

// Control characters and lone surrogates make the docx unreadable.
const BAD_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export const stripControls = (value: string) => value.replace(BAD_CHARS, "");
const str = (value: unknown) => (typeof value === "string" ? stripControls(value) : null);
const int = (value: unknown, min: number, max: number) =>
    typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : null;

function visualText(value: unknown): VisualText | null {
    if (typeof value === "string") return stripControls(value);
    if (!Array.isArray(value)) return null;
    const runs: Run[] = [];
    for (const run of value as Partial<Run>[]) {
        const text = str(run?.text);
        if (text === null) return null;
        runs.push({
            text,
            ...(run.strike === true ? { strike: true as const } : {}),
            ...(run.underline === true ? { underline: true as const } : {}),
            ...(run.bold === true ? { bold: true as const } : {}),
        });
    }
    return runs;
}

export function sanitizeTextBlock(block: unknown): TextBlock | null {
    if (!block || typeof block !== "object") return null;
    const raw = block as Record<string, unknown>;
    if (raw.type === "heading") {
        const text = str(raw.text);
        const level = int(raw.level, 1, 3);
        return text === null || level === null ? null : { type: "heading", level: level as 1 | 2 | 3, text };
    }
    if (raw.type === "paragraph") {
        const text = visualText(raw.text);
        if (text === null) return null;
        const bullet = int(raw.bullet, 0, 8);
        const style = raw.style === "small" || raw.style === "caption" ? raw.style : undefined;
        return { type: "paragraph", text, ...(bullet === null ? {} : { bullet }), ...(style ? { style } : {}) };
    }
    if (raw.type === "table") {
        if (!Array.isArray(raw.rows)) return null;
        const rows: VisualText[][] = [];
        for (const row of raw.rows) {
            if (!Array.isArray(row)) return null;
            const cells = row.map(visualText);
            if (cells.some((cell) => cell === null)) return null;
            rows.push(cells as VisualText[]);
        }
        return { type: "table", rows, header: raw.header === true, numeric: Array.isArray(raw.numeric) ? raw.numeric.map(Boolean) : [] };
    }
    return null;
}

// The page's own measurements cannot be trusted; the box comes from the browser.
async function shoot(locator: Locator, budget: number): Promise<Buffer | null> {
    const box = await locator.boundingBox({ timeout: SHOT_TIMEOUT_MS }).catch(() => null);
    if (!box || box.height > MAX_IMAGE_HEIGHT_PX || box.width > BLOCKS_PAGE_WIDTH) return null;
    const png = await locator.screenshot({ type: "png", animations: "disabled", caret: "hide", timeout: SHOT_TIMEOUT_MS });
    return png.length <= budget ? png : null;
}

export async function collectBlocks(page: Page, scale: number): Promise<VisualBlock[]> {
    // tsx, the dev runner, wraps inner functions in a __name helper that
    // exists only in the Node module.
    await page.evaluate("globalThis.__name ??= (fn) => fn");
    const read = (await page.evaluate(readBlocks)) as unknown[];
    const blocks: VisualBlock[] = [];
    let shots = 0;
    let bytes = 0;
    for (const block of read) {
        const raw = block as Partial<Extract<PageBlock, { type: "image" }>> | null;
        if (raw?.type !== "image") {
            const text = sanitizeTextBlock(block);
            if (text) blocks.push(text);
            continue;
        }
        const fallback = Array.isArray(raw.fallback) ? raw.fallback.map(sanitizeTextBlock).filter((b): b is TextBlock => b !== null) : [];
        const png =
            typeof raw.shot === "number" && shots < MAX_IMAGES
                ? await shoot(page.locator(`[data-mv-shot="${raw.shot}"]`), MAX_IMAGE_BYTES - bytes)
                : null;
        if (!png) {
            blocks.push(...fallback);
            continue;
        }
        shots++;
        bytes += png.length;
        blocks.push({
            type: "image",
            png,
            widthPx: Math.round(png.readUInt32BE(16) / scale),
            heightPx: Math.round(png.readUInt32BE(20) / scale),
            alt: str(raw.alt) || "Figure",
        });
    }
    return blocks;
}
