import type { McpSourceLink } from "@mike/contracts";

/** Bounded public-original witnesses; use for live frames and persisted history. */
export function parseMcpSourceLinks(value: unknown): McpSourceLink[] {
    if (!Array.isArray(value)) return [];
    return value.slice(0, 4).flatMap((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return [];
        const { source_id, label, url, basis } = item as Record<string, unknown>;
        if (
            typeof source_id !== "string" || !source_id.trim() || source_id.length > 200 ||
            typeof label !== "string" || !label.trim() || label.length > 240 ||
            typeof url !== "string" || !url || url.length > 2048 || !/^https?:\/\/[^/]/i.test(url) || /[\s\\]/.test(url) ||
            (basis !== "discovery" && basis !== "capture_observation")
        ) return [];
        try {
            const parsed = new URL(url);
            const host = parsed.hostname.toLowerCase();
            if (
                !/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password ||
                parsed.search || parsed.hash || !host.includes(".") || host.endsWith(".") ||
                host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") ||
                host.includes(":") || /^(\d+\.){3}\d+$/.test(host)
            ) return [];
        } catch { return []; }
        // Keep the exact returned URL, not URL.toString()'s normalized form.
        return [{ source_id, label, url, basis }];
    });
}
