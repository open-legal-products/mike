// An organization's workspace profile: a few structured facts about the
// organization (its name as a group, where it is based and operates, its
// financial year, currency and structure) and free text its owners and admins
// write for the assistant (house positions, standing instructions). Chats in
// the organization's workspace receive it as reference context.
//
// Behind the module facade (orgs.service.ts). One row per organization in
// org_profiles; members read it, owners and admins write it. A PUT replaces
// the whole profile: a field the body leaves out is cleared.

import { recordAudit } from "../../lib/audit";
import { getOrgRole, isOrgAdmin } from "../../lib/access";
import type { OrgResult } from "../../lib/orgs";
import type { Db } from "../../lib/supabase";

export type OrgProfile = {
    group_name: string | null;
    headquarters_jurisdiction: string | null;
    operating_jurisdictions: string[];
    fiscal_year_end: string | null;
    reporting_currency: string | null;
    group_structure: string | null;
    house_positions: string | null;
    standing_instructions: string | null;
    reviewed_on: string | null;
    updated_at: string | null;
};

/** What a client sends: the profile without its server-set timestamp. */
export type OrgProfileInput = Omit<OrgProfile, "updated_at">;

// The same caps as the CHECK constraints on public.org_profiles.
const SHORT_TEXT_MAX = 200;
const FISCAL_YEAR_END_MAX = 20;
const LONG_TEXT_MAX = 4000;
const JURISDICTIONS_MAX = 100;
const JURISDICTION_CODE_MAX = 10;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const PROFILE_COLUMNS =
    "group_name, headquarters_jurisdiction, operating_jurisdictions, fiscal_year_end, reporting_currency, group_structure, house_positions, standing_instructions, reviewed_on, updated_at";

const EMPTY_PROFILE: OrgProfile = {
    group_name: null,
    headquarters_jurisdiction: null,
    operating_jurisdictions: [],
    fiscal_year_end: null,
    reporting_currency: null,
    group_structure: null,
    house_positions: null,
    standing_instructions: null,
    reviewed_on: null,
    updated_at: null,
};

type Parsed<T> = { ok: true; value: T } | { ok: false; detail: string };

/** A trimmed string of at most `max` characters; blank or absent is null. */
function optionalText(
    value: unknown,
    field: string,
    max: number,
): Parsed<string | null> {
    if (value === undefined || value === null) return { ok: true, value: null };
    if (typeof value !== "string") {
        return { ok: false, detail: `${field} must be text.` };
    }
    const trimmed = value.trim();
    if (!trimmed) return { ok: true, value: null };
    if (trimmed.length > max) {
        return {
            ok: false,
            detail: `${field} must be at most ${max} characters.`,
        };
    }
    return { ok: true, value: trimmed };
}

function isRealDate(value: string): boolean {
    if (!DATE_PATTERN.test(value)) return false;
    const date = new Date(`${value}T00:00:00Z`);
    return (
        !Number.isNaN(date.getTime()) &&
        date.toISOString().slice(0, 10) === value
    );
}

/**
 * Validate a client's profile, with the same limits the table enforces, so a
 * bad value is a 400 with a reason instead of a constraint error.
 */
export function parseOrgProfileBody(
    body: unknown,
): { ok: true; profile: OrgProfileInput } | { ok: false; detail: string } {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        return { ok: false, detail: "The profile must be an object." };
    }
    const record = body as Record<string, unknown>;

    const groupName = optionalText(record.group_name, "group_name", SHORT_TEXT_MAX);
    if (!groupName.ok) return groupName;
    const headquarters = optionalText(
        record.headquarters_jurisdiction,
        "headquarters_jurisdiction",
        SHORT_TEXT_MAX,
    );
    if (!headquarters.ok) return headquarters;
    const fiscalYearEnd = optionalText(
        record.fiscal_year_end,
        "fiscal_year_end",
        FISCAL_YEAR_END_MAX,
    );
    if (!fiscalYearEnd.ok) return fiscalYearEnd;

    const currency = optionalText(record.reporting_currency, "reporting_currency", 3);
    if (!currency.ok) {
        return {
            ok: false,
            detail: "reporting_currency must be a three-letter code such as EUR.",
        };
    }
    if (currency.value !== null && !CURRENCY_PATTERN.test(currency.value)) {
        return {
            ok: false,
            detail: "reporting_currency must be a three-letter code such as EUR.",
        };
    }

    const longFields = [
        "group_structure",
        "house_positions",
        "standing_instructions",
    ] as const;
    const long: Partial<Record<(typeof longFields)[number], string | null>> = {};
    for (const field of longFields) {
        const parsed = optionalText(record[field], field, LONG_TEXT_MAX);
        if (!parsed.ok) return parsed;
        long[field] = parsed.value;
    }

    const rawJurisdictions = record.operating_jurisdictions ?? [];
    if (!Array.isArray(rawJurisdictions)) {
        return {
            ok: false,
            detail: "operating_jurisdictions must be a list of codes.",
        };
    }
    if (rawJurisdictions.length > JURISDICTIONS_MAX) {
        return {
            ok: false,
            detail: `operating_jurisdictions may list at most ${JURISDICTIONS_MAX} codes.`,
        };
    }
    const jurisdictions: string[] = [];
    for (const code of rawJurisdictions) {
        if (typeof code !== "string") {
            return {
                ok: false,
                detail: "operating_jurisdictions must be a list of codes.",
            };
        }
        const trimmed = code.trim();
        if (!trimmed) continue;
        if (trimmed.length > JURISDICTION_CODE_MAX) {
            return {
                ok: false,
                detail: `Each jurisdiction code must be at most ${JURISDICTION_CODE_MAX} characters.`,
            };
        }
        jurisdictions.push(trimmed);
    }

    const reviewedOn = optionalText(record.reviewed_on, "reviewed_on", 10);
    if (!reviewedOn.ok || (reviewedOn.value !== null && !isRealDate(reviewedOn.value))) {
        return { ok: false, detail: "reviewed_on must be a date (YYYY-MM-DD)." };
    }

    return {
        ok: true,
        profile: {
            group_name: groupName.value,
            headquarters_jurisdiction: headquarters.value,
            operating_jurisdictions: jurisdictions,
            fiscal_year_end: fiscalYearEnd.value,
            reporting_currency: currency.value,
            group_structure: long.group_structure ?? null,
            house_positions: long.house_positions ?? null,
            standing_instructions: long.standing_instructions ?? null,
            reviewed_on: reviewedOn.value,
        },
    };
}

function toProfile(row: Record<string, unknown> | null): OrgProfile {
    if (!row) return { ...EMPTY_PROFILE };
    return {
        ...EMPTY_PROFILE,
        ...(row as Partial<OrgProfile>),
        operating_jurisdictions: Array.isArray(row.operating_jurisdictions)
            ? (row.operating_jurisdictions as string[])
            : [],
    };
}

/** Read the organization's profile (any member); none stored reads as empty. */
export async function getOrgProfile(
    db: Db,
    params: { actorId: string; orgId: string },
): Promise<OrgResult<OrgProfile>> {
    const role = await getOrgRole(params.actorId, params.orgId, db);
    if (!role) return { ok: false, kind: "not_found" };

    const { data, error } = await db
        .from("org_profiles")
        .select(PROFILE_COLUMNS)
        .eq("org_id", params.orgId)
        .maybeSingle();
    if (error) return { ok: false, kind: "db_error", detail: error.message };
    return { ok: true, ...toProfile(data as Record<string, unknown> | null) };
}

/** Replace the organization's profile (owner or admin). */
export async function saveOrgProfile(
    db: Db,
    params: {
        actorId: string;
        actorEmail?: string | null;
        orgId: string;
        body: unknown;
    },
): Promise<OrgResult<OrgProfile>> {
    const role = await getOrgRole(params.actorId, params.orgId, db);
    if (!role) return { ok: false, kind: "not_found" };
    if (!isOrgAdmin(role)) return { ok: false, kind: "forbidden" };

    const parsed = parseOrgProfileBody(params.body);
    if (!parsed.ok) return { ok: false, kind: "validation", detail: parsed.detail };

    const { data, error } = await db
        .from("org_profiles")
        .upsert(
            {
                org_id: params.orgId,
                ...parsed.profile,
                updated_by: params.actorId,
                updated_at: new Date().toISOString(),
            },
            { onConflict: "org_id" },
        )
        .select(PROFILE_COLUMNS)
        .single();
    if (error) return { ok: false, kind: "db_error", detail: error.message };

    await recordAudit(db, {
        userId: params.actorId,
        userEmail: params.actorEmail ?? null,
        action: "org.profile.updated",
        // Never the profile's text.
        detail: { org_id: params.orgId },
    });
    return { ok: true, ...toProfile(data as Record<string, unknown> | null) };
}
