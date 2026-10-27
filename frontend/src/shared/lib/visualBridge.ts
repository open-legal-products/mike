/**
 * A visual is a self-contained HTML document the assistant wrote. It runs in
 * a sandboxed iframe and can only talk to the app through `postMessage`, so
 * everything it says is parsed here before anything acts on it. This module
 * is shared by the web app and the Word add-in and must stay framework-free.
 */

export type VisualTheme = "light" | "dark";

export type VisualCite = {
    /** A document uuid, or "active" for the document the user is working in. */
    cite: string;
    version?: string;
    quote?: string;
    page?: string;
    sheet?: string;
    cell?: string;
    clause?: string;
};

type VisualMessage =
    | { type: "mike:ready" }
    | { type: "mike:error" }
    | { type: "mike:cite"; cite: VisualCite };

export const STALE_SOURCE_NOTICE =
    "A source has changed since this was made. Ask Mike to update it.";

const MAX_STRING_LENGTH = 4000;
const UUID_PATTERN =
    /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const CITE_KEYS = ["version", "quote", "page", "sheet", "cell", "clause"] as const;
const VISUAL_EXTENSION = /\.html?$/i;

export function isVisualFilename(filename: string): boolean {
    return VISUAL_EXTENSION.test(filename);
}

export function visualTitle(filename: string): string {
    return filename.replace(VISUAL_EXTENSION, "");
}

function readString(value: unknown): string | null {
    return typeof value === "string" && value.length <= MAX_STRING_LENGTH
        ? value
        : null;
}

export function isVisualCiteTarget(value: string): boolean {
    return value === "active" || UUID_PATTERN.test(value);
}

export function parseVisualMessage(data: unknown): VisualMessage | null {
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    const message = data as Record<string, unknown>;
    if (message.type === "mike:ready") return { type: "mike:ready" };
    if (message.type === "mike:error") return { type: "mike:error" };
    if (message.type !== "mike:cite") return null;
    const target = readString(message.cite);
    if (target === null || !isVisualCiteTarget(target)) return null;
    const cite: VisualCite = { cite: target };
    for (const key of CITE_KEYS) {
        const raw = message[key === "version" ? "citeVersion" : key];
        if (raw === undefined) continue;
        const value = readString(raw);
        if (value === null) return null;
        cite[key] = value;
    }
    return { type: "mike:cite", cite };
}

export function withVisualTheme(html: string, theme: VisualTheme): string {
    return html.replace(/<html(\s[^>]*)?>/i, (_tag, attributes: string | undefined) => {
        const rest = (attributes ?? "").replace(/\sdata-theme\s*=\s*("[^"]*"|'[^']*'|[^\s>]*)/i, "");
        return `<html data-theme="${theme}"${rest}>`;
    });
}

function escapeAttribute(value: string): string {
    return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function escapeText(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

// The outer document's policy binds the visual whatever its own markup says.
// A sandbox never stops a frame navigating itself; `frame-src 'none'` does,
// and Chromium still loads the srcdoc child under it. A blocked navigation
// fires no second load, so the guard script's pagehide is the signal that the
// visual left; it can arrive with a null source once the page has unloaded.
const VISUAL_HOST_CSP =
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; font-src data:; img-src data: blob:; frame-src 'none'; form-action 'none'; base-uri 'none'";

export const VISUAL_INNER_SANDBOX = "allow-scripts";

const RELAY_SCRIPT = [
    "(function(){",
    "var frame=document.getElementById('visual');",
    "window.addEventListener('message',function(event){",
    "if(!frame.isConnected)return;",
    "if((event.source===frame.contentWindow||event.source===null)&&event.data&&event.data.type==='mike:left'){frame.remove();window.parent.postMessage({type:'mike:error'},'*');return;}",
    "if(event.source===frame.contentWindow){window.parent.postMessage(event.data,'*');return;}",
    "if(event.source===window.parent&&frame.contentWindow){frame.contentWindow.postMessage(event.data,'*');}",
    "});",
    "})();",
].join("");

const NAVIGATION_GUARD =
    "<script>addEventListener('pagehide',function(){parent.postMessage({type:'mike:left'},'*')})</script>";

/** Puts the navigation guard ahead of every script the visual brings. */
function withNavigationGuard(html: string): string {
    const head = html.match(/<head(\s[^>]*)?>/i);
    if (head?.index !== undefined) {
        const at = head.index + head[0].length;
        return `${html.slice(0, at)}${NAVIGATION_GUARD}${html.slice(at)}`;
    }
    const root = html.match(/<html(\s[^>]*)?>/i);
    if (root?.index !== undefined) {
        const at = root.index + root[0].length;
        return `${html.slice(0, at)}<head>${NAVIGATION_GUARD}</head>${html.slice(at)}`;
    }
    return `${NAVIGATION_GUARD}${html}`;
}

export function buildVisualHostDocument(
    visualHtml: string,
    title: string,
): string {
    return [
        "<!doctype html>",
        "<html>",
        "<head>",
        `<meta http-equiv="Content-Security-Policy" content="${VISUAL_HOST_CSP}">`,
        '<meta charset="utf-8">',
        `<title>${escapeText(title)}</title>`,
        "<style>html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:transparent}iframe{display:block;border:0;width:100%;height:100%}</style>",
        "</head>",
        "<body>",
        `<iframe id="visual" sandbox="${VISUAL_INNER_SANDBOX}" title="${escapeAttribute(title)}" srcdoc="${escapeAttribute(withNavigationGuard(visualHtml))}"></iframe>`,
        `<script>${RELAY_SCRIPT}</script>`,
        "</body>",
        "</html>",
    ].join("");
}
