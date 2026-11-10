/**
 * Search across a person's settings.
 *
 * The index is a hand-written list of every section and control, each with
 * the words people actually use for it. Two kinds of result come back:
 *
 * - "exact": the query is the name of a section, a tab, or one of its
 *   controls, or a whole phrase inside one. These rank first.
 * - "related": the query means the same thing by other words ("api key" for
 *   Bring Your Own Keys, "dark" for Appearance, "2fa" for Security), or is
 *   close enough in spelling to count as a typo. Matching goes through the
 *   entry's vocabulary (its description and keywords), word prefixes, and a
 *   character-bigram similarity so a mistyped word still lands.
 *
 * Everything runs in the browser against this static list, so results are
 * instant and need no key or network.
 */

export type SettingsSearchEntry = {
    /** Stable id, also the React key. */
    id: string;
    /** The tab's id in the settings layout, for hiding entries with their tab. */
    tabId: string;
    /** The tab's label, shown as the result's trail. */
    tab: string;
    /** The section or control the result opens. */
    title: string;
    /** One sentence about what it does; shown and searched. */
    description: string;
    /** Other words for the same thing: synonyms, jargon, related nouns. */
    keywords: readonly string[];
    /** Where it is, with a hash for the section heading when there is one. */
    href: string;
};

export type SettingsSearchMatchKind = "exact" | "related";

export type SettingsSearchResult = {
    entry: SettingsSearchEntry;
    kind: SettingsSearchMatchKind;
    score: number;
};

export const SETTINGS_SEARCH_ENTRIES: readonly SettingsSearchEntry[] = [
    // Account
    {
        id: "account-profile",
        tabId: "account",
        tab: "Account",
        title: "Profile",
        description: "Your display name and profile photo.",
        keywords: ["name", "display name", "photo", "picture", "avatar", "upload photo", "username", "nickname"],
        href: "/settings#profile",
    },
    {
        id: "account-email",
        tabId: "account",
        tab: "Account",
        title: "Email",
        description: "The email address you sign in with, and how to change it.",
        keywords: ["email address", "change email", "update email", "login email", "sign in", "mail"],
        href: "/settings#email",
    },
    {
        id: "account-plan",
        tabId: "account",
        tab: "Account",
        title: "Usage Plan",
        description: "The plan your account is on.",
        keywords: ["plan", "subscription", "billing", "free", "pro", "tier", "upgrade", "pricing", "usage"],
        href: "/settings#usage-plan",
    },
    {
        id: "account-delete",
        tabId: "account",
        tab: "Account",
        title: "Delete account",
        description: "Permanently delete your account and personal workspace.",
        keywords: ["danger zone", "remove account", "close account", "deactivate", "cancel account", "erase"],
        href: "/settings#danger-zone",
    },

    // Personalisation
    {
        id: "personalisation-background",
        tabId: "personalisation",
        tab: "Personalisation",
        title: "Your background",
        description: "Your title, professional setting, jurisdiction and practice areas, so responses fit your context.",
        keywords: ["role", "job title", "profession", "jurisdiction", "country", "practice area", "practice areas", "law firm", "in-house", "lawyer", "solicitor", "attorney", "context", "personalization", "profile", "about me"],
        href: "/settings/personalisation#your-background",
    },
    {
        id: "personalisation-response-style",
        tabId: "personalisation",
        tab: "Personalisation",
        title: "Response style",
        description: "How Mike shapes its answers: verbosity, tone and language.",
        keywords: ["verbosity", "concise", "detailed", "tone", "language", "formal", "casual", "length", "short answers", "long answers", "writing style", "output style", "translate", "locale"],
        href: "/settings/personalisation#response-style-heading",
    },

    // Memory
    {
        id: "memory",
        tabId: "memory",
        tab: "Memory",
        title: "Memory",
        description: "Whether Mike remembers durable information from your conversations.",
        keywords: ["remember", "forget", "memories", "recall", "context", "history", "learn", "retain", "memorise", "memorize"],
        href: "/settings/memory#app-memory-settings-heading",
    },
    {
        id: "memory-file",
        tabId: "memory",
        tab: "Memory",
        title: "Memory file",
        description: "Read and edit what Mike has remembered about you.",
        keywords: ["edit memory", "memory notes", "what mike knows", "saved facts", "clear memory", "memory contents"],
        href: "/settings/memory#app-memory-file-heading",
    },

    // Appearance
    {
        id: "appearance-dark-mode",
        tabId: "appearance",
        tab: "Appearance",
        title: "Dark mode",
        description: "Use a darker color palette throughout Mike.",
        keywords: ["theme", "dark", "light mode", "night mode", "colour", "color", "palette", "display", "look", "contrast", "black background"],
        href: "/settings/appearance#appearance",
    },

    // Features
    {
        id: "features-quick-actions",
        tabId: "features",
        tab: "Features",
        title: "Quick actions",
        description: "Show the quick actions row on the assistant start screen.",
        keywords: ["shortcuts", "start screen", "home screen", "suggestions", "prompt suggestions", "assistant", "buttons"],
        href: "/settings/features#assistant-features",
    },
    {
        id: "features-response-details",
        tabId: "features",
        tab: "Features",
        title: "Response details",
        description: "Show the model, reasoning effort and token count under each response and subagent.",
        keywords: ["token count", "tokens", "usage", "model name", "reasoning effort", "metadata", "debug", "stats", "show model", "cost"],
        href: "/settings/features#assistant-features",
    },

    // Privacy & Data
    {
        id: "privacy-export",
        tabId: "privacy-data",
        tab: "Privacy & Data",
        title: "Export data",
        description: "Download your chats, tabular reviews, account JSON and memory.",
        keywords: ["download", "backup", "export chats", "export reviews", "json", "take my data", "data portability", "gdpr", "archive", "copy of my data"],
        href: "/settings/privacy-data#export-data",
    },
    {
        id: "privacy-delete",
        tabId: "privacy-data",
        tab: "Privacy & Data",
        title: "Delete data",
        description: "Delete all your chats, tabular reviews, projects or memory.",
        keywords: ["delete chats", "delete all chats", "clear history", "delete projects", "delete reviews", "delete memory", "wipe", "erase", "purge", "remove data", "clear everything", "gdpr"],
        href: "/settings/privacy-data#delete-data",
    },

    // My Activity
    {
        id: "my-activity",
        tabId: "my-activity",
        tab: "My Activity",
        title: "My Activity",
        description: "A log of what you have done in Mike.",
        keywords: ["activity log", "audit", "audit log", "history", "events", "recent actions", "what did i do", "timeline", "sessions"],
        href: "/settings/my-activity",
    },

    // Security
    {
        id: "security-mfa",
        tabId: "security",
        tab: "Security",
        title: "Multi-Factor Authentication",
        description: "Add an authenticator app to protect sensitive actions, and ask for a code on every login.",
        keywords: ["mfa", "2fa", "two factor", "two-factor", "two step", "authenticator", "authenticator app", "totp", "verification code", "login verification", "one time code", "otp", "google authenticator", "authy", "secure account", "protect account"],
        href: "/settings/security#multi-factor-authentication",
    },
    {
        id: "security-password",
        tabId: "security",
        tab: "Security",
        title: "Password",
        description: "Set a password or send yourself a password-reset link.",
        keywords: ["change password", "reset password", "forgot password", "new password", "passcode", "credentials", "login", "sign in"],
        href: "/settings/security#password",
    },

    // Model Preferences
    {
        id: "models-chat-title",
        tabId: "models",
        tab: "Model Preferences",
        title: "Chat title generation",
        description: "Which model names your chats.",
        keywords: ["chat titles", "conversation name", "auto title", "naming", "cheap model", "low cost model"],
        href: "/settings/models#model-preferences",
    },
    {
        id: "models-tabular",
        tabId: "models",
        tab: "Model Preferences",
        title: "Tabular review model",
        description: "The model preselected when you create a tabular review.",
        keywords: ["tabular", "review model", "table review", "spreadsheet", "extraction model", "default model"],
        href: "/settings/models#model-preferences",
    },
    {
        id: "models-memory",
        tabId: "models",
        tab: "Model Preferences",
        title: "Memory curation model",
        description: "The model that decides what is worth remembering after a conversation.",
        keywords: ["memory model", "curation", "remember", "default model"],
        href: "/settings/models#model-preferences",
    },
    {
        id: "models-subagents",
        tabId: "models",
        tab: "Model Preferences",
        title: "Subagents",
        description: "The default model and reasoning effort for the subagents Mike hands work to.",
        keywords: ["subagent", "sub-agent", "agents", "reasoning", "reasoning effort", "thinking", "delegate", "parallel", "worker model", "effort level"],
        href: "/settings/models#subagents-heading",
    },

    // Bring Your Own Keys
    {
        id: "byok",
        tabId: "byok",
        tab: "Bring Your Own Keys",
        title: "Bring Your Own Keys",
        description: "Add your own API keys for model providers such as Anthropic, OpenAI, Google and Azure.",
        keywords: ["byok", "api key", "api keys", "key", "keys", "token", "secret", "credentials", "provider", "providers", "model provider", "anthropic", "claude", "openai", "chatgpt", "gpt", "gemini", "google", "mistral", "xai", "grok", "bedrock", "aws", "azure", "vertex", "openrouter", "vercel", "ai gateway", "custom endpoint", "base url", "own model", "connect model", "llm", "add key", "add provider", "enable provider", "disable provider", "no models", "missing key"],
        href: "/settings/byok",
    },

    // Connectors
    {
        id: "connectors-installed",
        tabId: "connectors",
        tab: "Connectors",
        title: "Installed connectors",
        description: "The data sources and tools connected to this workspace.",
        keywords: ["connector", "integration", "integrations", "mcp", "mcp server", "plugin", "plugins", "tools", "data source", "connected apps", "remove connector", "disconnect"],
        href: "/settings/connectors#installed-connectors-heading",
    },
    {
        id: "connectors-discover",
        tabId: "connectors",
        tab: "Connectors",
        title: "Discover connectors",
        description: "Connect Google Drive, Gmail, Calendar, CourtListener, or a custom MCP server.",
        keywords: ["google drive", "gmail", "google calendar", "calendar", "drive", "courtlistener", "court listener", "case law", "add connector", "custom connector", "mcp", "oauth", "connect google", "link account", "integration"],
        href: "/settings/connectors#discover-connectors-heading",
    },

    // Organizations
    {
        id: "organizations",
        tabId: "organizations",
        tab: "Organizations",
        title: "My organizations",
        description: "The organizations you belong to, and each one's settings.",
        keywords: ["organisation", "organization", "org", "team", "workspace", "company", "firm", "members", "admin", "switch organization", "leave organization", "create organization"],
        href: "/settings/organizations#my-organizations-heading",
    },
    {
        id: "organizations-invitations",
        tabId: "organizations",
        tab: "Organizations",
        title: "Invitations",
        description: "Organizations that have invited you to join.",
        keywords: ["invite", "invitation", "invited", "join", "join team", "pending invitations", "accept invitation", "decline"],
        href: "/settings/organizations#my-invitations-heading",
    },
];

// Words that carry no meaning on their own; a query of only these matches
// nothing rather than everything.
const STOP_WORDS = new Set([
    "a", "an", "the", "and", "or", "of", "to", "for", "in", "on", "my", "me",
    "i", "is", "it", "do", "how", "can", "where", "find", "change", "set",
    "setting", "settings", "want", "with", "up",
]);

function normalise(text: string): string {
    return text
        .toLowerCase()
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
}

/** Folds the commonest plural and British/American spellings into one token. */
function stem(word: string): string {
    let w = word.replace(/isation$/, "ization").replace(/ise$/, "ize");
    if (w.length > 4 && w.endsWith("ies")) w = `${w.slice(0, -3)}y`;
    else if (w.length > 3 && w.endsWith("es") && !w.endsWith("ses")) w = w.slice(0, -2);
    else if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
    return w;
}

function tokens(text: string): string[] {
    return normalise(text).split(" ").filter(Boolean).map(stem);
}

function bigrams(word: string): Set<string> {
    const out = new Set<string>();
    for (let i = 0; i < word.length - 1; i += 1) out.add(word.slice(i, i + 2));
    return out;
}

/**
 * Sørensen–Dice similarity over character bigrams, 0..1. The caller only
 * compares two different words of four or more letters, so both have bigrams.
 */
function similarity(a: string, b: string): number {
    const ga = bigrams(a);
    const gb = bigrams(b);
    let shared = 0;
    for (const g of ga) if (gb.has(g)) shared += 1;
    return (2 * shared) / (ga.size + gb.size);
}

type IndexedName = {
    /** The phrase, normalised, and the same with its words stemmed. */
    phrase: string;
    stemmed: string;
    /** 2 for the title, 1.5 for the tab, 1 for a keyword. */
    rank: number;
};

type IndexedEntry = {
    entry: SettingsSearchEntry;
    /** Phrases a query can equal or sit inside to count as exact. */
    names: IndexedName[];
    /** Every word in the entry, with how strongly it identifies the entry. */
    vocabulary: Map<string, number>;
};

type Index = {
    entries: IndexedEntry[];
    /** Every word any entry knows; typo tolerance applies only outside it. */
    known: Set<string>;
};

const NAME_WEIGHT = 1;
const KEYWORD_WEIGHT = 0.9;
const DESCRIPTION_WEIGHT = 0.6;

function addWords(vocabulary: Map<string, number>, text: string, weight: number) {
    for (const word of tokens(text)) {
        if (STOP_WORDS.has(word)) continue;
        const current = vocabulary.get(word) ?? 0;
        if (weight > current) vocabulary.set(word, weight);
    }
}

function indexName(text: string, rank: number): IndexedName {
    return { phrase: normalise(text), stemmed: tokens(text).join(" "), rank };
}

function index(entry: SettingsSearchEntry): IndexedEntry {
    const vocabulary = new Map<string, number>();
    addWords(vocabulary, entry.title, NAME_WEIGHT);
    addWords(vocabulary, entry.tab, NAME_WEIGHT);
    for (const keyword of entry.keywords) addWords(vocabulary, keyword, KEYWORD_WEIGHT);
    addWords(vocabulary, entry.description, DESCRIPTION_WEIGHT);
    return {
        entry,
        names: [
            indexName(entry.title, 2),
            indexName(entry.tab, 1.5),
            ...entry.keywords.map((keyword) => indexName(keyword, 1)),
        ],
        vocabulary,
    };
}

const indexCache = new WeakMap<readonly SettingsSearchEntry[], Index>();

function indexed(entries: readonly SettingsSearchEntry[]): Index {
    let result = indexCache.get(entries);
    if (!result) {
        const indexedEntries = entries.map(index);
        const known = new Set<string>();
        for (const item of indexedEntries)
            for (const word of item.vocabulary.keys()) known.add(word);
        result = { entries: indexedEntries, known };
        indexCache.set(entries, result);
    }
    return result;
}

function containsPhrase(name: string, phrase: string): boolean {
    if (name === phrase) return true;
    const at = name.indexOf(phrase);
    if (at < 0) return false;
    const before = at === 0 || name[at - 1] === " ";
    const end = at + phrase.length;
    const after = end === name.length || name[end] === " ";
    return before && after;
}

/**
 * Whether a query word is one the index knows, as a word or as the start of
 * one. A known word is taken at face value; only an unknown one is treated as
 * a possible typo, so "model" never drifts to "mode".
 */
function isKnown(word: string, known: Set<string>): boolean {
    if (known.has(word)) return true;
    if (word.length < 3) return false;
    for (const candidate of known) if (candidate.startsWith(word)) return true;
    return false;
}

/**
 * How well one query word is explained by the entry's vocabulary, 0..1. A
 * word the index knows must match as itself or as the start of a longer
 * word; one it does not know may also be a longer form ("exporting") or a
 * misspelling of a known word.
 */
function wordScore(
    word: string,
    vocabulary: Map<string, number>,
    allowTypo: boolean,
): number {
    let best = 0;
    for (const [known, weight] of vocabulary) {
        let fit = 0;
        if (known === word) fit = 1;
        else if (word.length >= 3 && known.startsWith(word)) fit = 0.85;
        else if (allowTypo && known.length >= 3 && word.startsWith(known))
            fit = 0.7;
        else if (allowTypo && word.length >= 4 && known.length >= 4) {
            const close = similarity(word, known);
            if (close >= 0.6) fit = close * 0.8;
        }
        const score = fit * weight;
        if (score > best) best = score;
    }
    return best;
}

/** Score below which a related match is noise rather than meaning. */
const RELATED_THRESHOLD = 0.5;

/**
 * Searches the entries, exact matches first and related matches after, each
 * group ordered by strength. An empty or stop-word-only query gives nothing.
 */
export function searchSettings(
    query: string,
    entries: readonly SettingsSearchEntry[] = SETTINGS_SEARCH_ENTRIES,
): SettingsSearchResult[] {
    const phrase = normalise(query);
    if (!phrase) return [];
    const words = tokens(query).filter((word) => !STOP_WORDS.has(word));
    if (words.length === 0) return [];
    const stemmedPhrase = words.join(" ");

    const { entries: items, known } = indexed(entries);
    const typoAllowed = words.map((word) => !isKnown(word, known));

    const results: SettingsSearchResult[] = [];
    for (const item of items) {
        // A title hit outranks a tab hit outranks a keyword hit, and a name the
        // query fills more of is a closer one.
        let exact = 0;
        for (const name of item.names) {
            const hit = containsPhrase(name.phrase, phrase)
                ? phrase.length / name.phrase.length
                : containsPhrase(name.stemmed, stemmedPhrase)
                  ? stemmedPhrase.length / name.stemmed.length
                  : 0;
            if (hit > 0) exact = Math.max(exact, name.rank + hit);
        }
        if (exact > 0) {
            results.push({ entry: item.entry, kind: "exact", score: exact });
            continue;
        }

        let total = 0;
        let matched = 0;
        words.forEach((word, i) => {
            const score = wordScore(word, item.vocabulary, typoAllowed[i]);
            if (score > 0) matched += 1;
            total += score;
        });
        if (matched === 0 || matched * 2 < words.length) continue;
        // Half coverage, half strength of what did match, so one unknown word
        // ("gpt-4") does not sink an otherwise clear query.
        const score = (total / words.length + total / matched) / 2;
        if (score < RELATED_THRESHOLD) continue;
        results.push({ entry: item.entry, kind: "related", score });
    }

    return results.sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === "exact" ? -1 : 1;
        return b.score - a.score;
    });
}
