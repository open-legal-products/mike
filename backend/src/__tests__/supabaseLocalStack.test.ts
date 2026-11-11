import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// `supabase start` (used by `npm run test:stack` and `npm run test:e2e:local`)
// boots one container per service enabled in backend/supabase/config.toml.
// `supabase init` writes that file with every service on, and the five below
// are most of the stack's memory (over 2 GB with them, about 0.4 GB
// without) while no Mike code calls any of them: answers stream over the
// backend's own server-sent events, files live in S3-compatible object
// storage, and there are no Edge Functions. The CI workflows never showed the
// cost because they generate a throwaway config and pass an explicit `-x`
// exclusion list, so only contributor machines ran the full set.
//
// This test keeps a regenerated or hand-edited config from switching them
// back on unnoticed. To use Studio locally, set `[studio] enabled = true` on
// your machine without committing it (see "Supabase CLI stack" in
// docs/local-development.md). If Mike starts using one of these services,
// remove it from this list in the same change that adds the first caller.
const UNUSED_SERVICES = [
    "realtime",
    "studio",
    "storage",
    "edge_runtime",
    "analytics",
] as const;

const config = readFileSync(
    path.resolve(__dirname, "../../supabase/config.toml"),
    "utf8",
);

/** The `enabled` value directly under `[section]`, or undefined if absent. */
function sectionEnabled(section: string): string | undefined {
    let inSection = false;
    for (const raw of config.split("\n")) {
        const line = raw.trim();
        if (line.startsWith("[")) {
            if (inSection) return undefined;
            inSection = line === `[${section}]`;
            continue;
        }
        if (!inSection) continue;
        const match = line.match(/^enabled\s*=\s*(\S+)/);
        if (match) return match[1];
    }
    return undefined;
}

describe("Supabase CLI stack config", () => {
    it.each(UNUSED_SERVICES)("keeps the unused %s service off", (service) => {
        expect(
            sectionEnabled(service),
            `[${service}] must stay \`enabled = false\` in backend/supabase/config.toml: ` +
                "Mike does not call it and it only adds memory to every contributor's local stack",
        ).toBe("false");
    });

    it.each(["api", "auth"])("keeps the %s service Mike depends on", (service) => {
        expect(sectionEnabled(service)).toBe("true");
    });
});
