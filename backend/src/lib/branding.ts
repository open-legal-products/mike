// The product's name and the assistant's persona, read from the environment so
// a deployment can rebrand the prompts without a code change. Each value is
// read on every call (tests set and unset the variables), trimmed, and falls
// back to Mike's own wording when unset or blank.

const DEFAULT_APP_NAME = "Mike";
const DEFAULT_ASSISTANT_PERSONA =
    "an AI legal assistant for lawyers and legal professionals. Help analyze documents, answer legal questions, and draft legal documents.";
const DEFAULT_APP_DOMAIN = "legal";

function envOr(name: string, fallback: string): string {
    const value = process.env[name]?.trim();
    return value ? value : fallback;
}

/** The product name the assistant introduces itself with (APP_NAME). */
export function appName(): string {
    return envOr("APP_NAME", DEFAULT_APP_NAME);
}

/**
 * What the assistant is, completing "You are <name>, ..." in the main chat
 * prompt (APP_ASSISTANT_PERSONA).
 */
export function assistantPersona(): string {
    return envOr("APP_ASSISTANT_PERSONA", DEFAULT_ASSISTANT_PERSONA);
}

/**
 * The field the product works in, as one lower-case adjective: "a legal
 * document analyst", "an AI legal assistant" (APP_DOMAIN).
 */
export function appDomain(): string {
    return envOr("APP_DOMAIN", DEFAULT_APP_DOMAIN);
}
