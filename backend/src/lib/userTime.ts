/**
 * The current date and the user's local time, for the assistant's prompt.
 *
 * Prompt caching only reuses a request prefix that is byte-identical to the
 * previous one, so nothing here changes between requests: the system prompt
 * carries fixed text only, and each user message (and each answer to the
 * assistant's questions) carries the immutable time it was sent.
 */

export const DEFAULT_TIME_ZONE = "UTC";

/** An IANA time zone the runtime understands (e.g. "Europe/London"), else null. */
export function normalizeTimeZone(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const zone = value.trim();
    if (!zone || zone.length > 64) return null;
    try {
        return new Intl.DateTimeFormat("en-US", { timeZone: zone })
            .resolvedOptions().timeZone;
    } catch {
        return null;
    }
}

/** Use the time zone sent with this request, falling back to UTC. */
export function resolveRequestTimeZone(requested: unknown): string {
    return normalizeTimeZone(requested) ?? DEFAULT_TIME_ZONE;
}

const WEEKDAYS = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
] as const;
const MONTHS = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
] as const;

/**
 * The local calendar fields for a moment in a zone. Only numbers come from
 * Intl; names come from the tables above, because ICU versions disagree on
 * punctuation and abbreviations ("Sep" vs "Sept"), and a stamp on an earlier
 * message must never change when the runtime is upgraded.
 */
function localParts(date: Date, timeZone: string) {
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone,
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "numeric",
        hourCycle: "h23",
    }).formatToParts(date);
    const num = (type: Intl.DateTimeFormatPartTypes) =>
        Number(parts.find((p) => p.type === type)?.value ?? 0);
    const year = num("year");
    const month = num("month");
    const day = num("day");
    // Day of week from the local calendar date, independent of locale names.
    const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    return { year, month, day, weekday, hour: num("hour") % 24, minute: num("minute") };
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** "Thu 1 Oct 2026, 14:05" in the given zone. */
export function formatMessageTime(date: Date, timeZone: string): string {
    const t = localParts(date, timeZone);
    return `${WEEKDAYS[t.weekday].slice(0, 3)} ${t.day} ${MONTHS[t.month - 1].slice(0, 3)} ${t.year}, ${pad2(t.hour)}:${pad2(t.minute)}`;
}

/**
 * System prompt section explaining the stamps. Fixed text, so it never
 * invalidates the prompt cache; the date and time live in the stamps.
 */
export const MESSAGE_TIME_PROMPT = `MESSAGE TIMES:
- Each user message begins with a [Sent: …] stamp: the date and time it was sent, in the user's local time zone.
- When the user answers your questions or approves an action, your previous turn's tool activity includes an [Answered: …] stamp with when they responded.
- The latest stamp is the current date and time. Use it to resolve "today", "tomorrow", deadlines, and other relative dates.
- The stamps are added by the application, not typed by the user. Do not repeat or mention them.`;

/** The stamp prepended to a user message. */
export function userMessageTimeStamp(sentAt: Date, timeZone: string): string {
    return `[Sent: ${formatMessageTime(sentAt, timeZone)} (${timeZone})]`;
}

/** The stamp on the user's answers to questions or approval requests. */
export function answerTimeStamp(answeredAt: Date, timeZone: string): string {
    return `[Answered: ${formatMessageTime(answeredAt, timeZone)} (${timeZone})]`;
}
