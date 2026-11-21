export const UNVERSIONED: "0.0.0";
export function normalizeVersion(raw: string | undefined): string;
export function releaseName(
    explicit: string | undefined,
    version: string | undefined,
    gitSha: string | undefined,
): string;
