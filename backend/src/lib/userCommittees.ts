import { resolveModel } from "./llm/models";
import { getCommitteeModel } from "./llm/registry";
import type { CommitteeModel } from "./llm/types";
import { createServerSupabase } from "./supabase";

// Committees a user builds in Settings, as opposed to the ones a deployment
// declares in MIKE_MODEL_CONFIG_JSON. User committees are namespaced so the
// two can never collide, and are deliberately shallow: a user committee may
// not contain another committee.

export const USER_COMMITTEE_PREFIX = "user-committee/";
export const MAX_USER_COMMITTEES = 8;
export const MAX_COMMITTEE_MEMBERS = 8;
export const MIN_COMMITTEE_MEMBERS = 2;
export const MAX_COMMITTEE_LABEL_LENGTH = 80;

export function isUserCommitteeId(value: string | null | undefined): boolean {
    return !!value?.startsWith(USER_COMMITTEE_PREFIX);
}

function memberModelId(member: CommitteeModel["members"][number]): string {
    return typeof member === "string" ? member : member.model;
}

/**
 * Best-effort read of whatever is stored on the profile. Anything malformed
 * is dropped rather than thrown: a bad row must not lock a user out of their
 * own settings page.
 */
export function normalizeUserCommittees(value: unknown): CommitteeModel[] {
    let candidate = value;
    if (typeof candidate === "string") {
        try {
            candidate = JSON.parse(candidate);
        } catch {
            return [];
        }
    }
    if (!Array.isArray(candidate)) return [];

    return candidate
        .slice(0, MAX_USER_COMMITTEES)
        .map((entry): CommitteeModel | null => {
            if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
                return null;
            }
            const record = entry as Record<string, unknown>;
            const id = typeof record.id === "string" ? record.id.trim() : "";
            const label =
                typeof record.label === "string" ? record.label.trim() : "";
            const chair =
                typeof record.chair === "string" ? record.chair.trim() : "";
            if (
                !isUserCommitteeId(id) ||
                !label ||
                !chair ||
                !Array.isArray(record.members)
            ) {
                return null;
            }
            const members = record.members
                .map((member) => {
                    if (typeof member === "string") return member.trim();
                    if (
                        !member ||
                        typeof member !== "object" ||
                        Array.isArray(member)
                    ) {
                        return "";
                    }
                    const model = (member as Record<string, unknown>).model;
                    return typeof model === "string" ? model.trim() : "";
                })
                .filter(Boolean)
                .slice(0, MAX_COMMITTEE_MEMBERS);
            if (members.length < MIN_COMMITTEE_MEMBERS) return null;
            return { id, label, members, chair, strategy: "synthesize" };
        })
        .filter((committee): committee is CommitteeModel => committee !== null);
}

/**
 * Strict check for the write path, where a bad payload should be an explicit
 * 4xx rather than silently dropped data.
 */
export function validateUserCommittees(value: unknown): CommitteeModel[] {
    if (!Array.isArray(value)) {
        throw new Error("modelCommittees must be an array.");
    }
    if (value.length > MAX_USER_COMMITTEES) {
        throw new Error(
            `You can configure up to ${MAX_USER_COMMITTEES} committees.`,
        );
    }

    const normalized = normalizeUserCommittees(value);
    if (normalized.length !== value.length) {
        throw new Error(
            `Each committee needs a name, a chair, and between ${MIN_COMMITTEE_MEMBERS} and ${MAX_COMMITTEE_MEMBERS} members.`,
        );
    }

    const ids = new Set<string>();
    for (const committee of normalized) {
        const label = committee.label ?? "";
        if (label.length > MAX_COMMITTEE_LABEL_LENGTH) {
            throw new Error(
                `Committee names must be ${MAX_COMMITTEE_LABEL_LENGTH} characters or fewer.`,
            );
        }
        if (ids.has(committee.id) || getCommitteeModel(committee.id)) {
            throw new Error(`Committee id ${committee.id} is already in use.`);
        }
        ids.add(committee.id);

        const memberIds = committee.members.map(memberModelId);
        if (new Set(memberIds).size !== memberIds.length) {
            throw new Error(
                `${label} contains the same member more than once.`,
            );
        }
        for (const model of [...memberIds, committee.chair]) {
            if (isUserCommitteeId(model) || getCommitteeModel(model)) {
                throw new Error("A committee cannot contain another committee.");
            }
            if (resolveModel(model, "") !== model) {
                throw new Error(`Unknown committee model: ${model}`);
            }
        }
    }
    return normalized;
}

// Postgres raises undefined_column (42703); PostgREST reports a column that
// is missing from its schema cache as PGRST204. Both arms require the message
// to name model_committees, so an unrelated schema fault still surfaces
// instead of being reported as "you have no committees".
function isMissingCommitteesColumn(error: unknown): boolean {
    const record =
        error && typeof error === "object"
            ? (error as { code?: unknown; message?: unknown })
            : {};
    const code = typeof record.code === "string" ? record.code : "";
    const message = typeof record.message === "string" ? record.message : "";
    return (
        (code === "42703" || code === "PGRST204") &&
        message.includes("model_committees")
    );
}

export async function getUserCommittees(
    userId: string,
    db: ReturnType<typeof createServerSupabase> = createServerSupabase(),
): Promise<CommitteeModel[]> {
    const { data, error } = await db
        .from("user_profiles")
        .select("model_committees")
        .eq("user_id", userId)
        .maybeSingle();
    if (error) {
        // Deploy-before-migrate tolerance, matching selectProfile: a database
        // without the model_committees column reports "no committees" rather
        // than failing every chat and tabular request.
        if (isMissingCommitteesColumn(error)) return [];
        const detail =
            typeof error === "object" && error && "message" in error
                ? String(error.message)
                : String(error);
        throw new Error(`Unable to load model committees: ${detail}`);
    }
    if (!data) return [];
    return normalizeUserCommittees(
        (data as { model_committees?: unknown }).model_committees,
    );
}
