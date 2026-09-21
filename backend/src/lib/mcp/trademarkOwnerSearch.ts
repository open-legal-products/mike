// Exact-owner trademark search adapter.
//
// This module wraps the upstream TMSEARCH MCP tool so that an "exact owner"
// portfolio search stays reliable end to end. It pages the connector's
// candidate set in small chunks (the connector has a per-response size
// budget, and one tmsearch record can carry a large goods/services text),
// retries on HTTP 429 with a fixed backoff schedule, falls back off the
// Elasticsearch owner-field phrase query if a deployment rejects it, filters
// candidates locally to normalized exact owner-name matches, and projects
// each record down to a compact portfolio shape. A batch mode runs several
// owners serially with pacing and reports per-owner failures so the caller
// can retry only the owners that did not complete.
//
// The file is self-contained: it only needs a `callTool` function that
// invokes the upstream trademark search tool and returns its raw result.

// Keep upstream pages below the connector's per-response token budget. A
// large tmsearch record can contain substantial goods/services text, and the
// connector may otherwise truncate a page before we can paginate it.
const OWNER_SEARCH_PAGE_SIZE = 10;
const OWNER_SEARCH_PAGE_INTERVAL_MS = 1_000;
const OWNER_SEARCH_BATCH_INTERVAL_MS = 2_500;
const TRADEMARK_RATE_LIMIT_MAX_RETRIES = 3;
const TRADEMARK_RATE_LIMIT_BASE_DELAY_MS = 10_000;
const TRADEMARK_RATE_LIMIT_MAX_DELAY_MS = 30_000;
const TRADEMARK_RATE_LIMIT_RETRY_AFTER_SECONDS = 60;
export const MAX_EXACT_OWNER_BATCH_SIZE = 10;
export const MAX_EXACT_OWNER_CANDIDATES = 1_000;

type TrademarkEnvelope = {
    success?: boolean;
    error?: boolean;
    message?: string;
    statusCode?: number;
    errorCode?: string;
    results: Array<Record<string, unknown>>;
    total: number;
    offset: number;
    hasMore: boolean;
};

function parseJson(value: string): unknown {
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}

function findTrademarkEnvelope(
    value: unknown,
    seen = new Set<unknown>(),
): Record<string, unknown> | null {
    if (typeof value === "string") {
        return findTrademarkEnvelope(parseJson(value), seen);
    }
    if (!value || typeof value !== "object" || seen.has(value)) return null;
    seen.add(value);
    const row = value as Record<string, unknown>;
    if (
        Array.isArray(row.results) ||
        row.error === true ||
        row.success === false
    ) {
        return row;
    }
    for (const candidate of [row.structuredContent, row.result]) {
        const found = findTrademarkEnvelope(candidate, seen);
        if (found) return found;
    }
    if (Array.isArray(row.content)) {
        for (const item of row.content) {
            const found = findTrademarkEnvelope(item, seen);
            if (found) return found;
        }
    }
    if (typeof row.text === "string") {
        return findTrademarkEnvelope(row.text, seen);
    }
    return null;
}

export function parseTrademarkToolResult(value: unknown): TrademarkEnvelope {
    const envelope = findTrademarkEnvelope(value);
    if (!envelope) {
        throw new Error(
            "The trademark connector returned an unsupported response shape.",
        );
    }
    const rawResults = Array.isArray(envelope.results) ? envelope.results : [];
    const results = rawResults.filter(
        (item): item is Record<string, unknown> =>
            !!item && typeof item === "object" && !Array.isArray(item),
    );
    const numericTotal = Number(envelope.total);
    const total =
        Number.isFinite(numericTotal) && numericTotal >= 0
            ? numericTotal
            : results.length;
    const numericOffset = Number(envelope.offset);
    const offset =
        Number.isFinite(numericOffset) && numericOffset >= 0
            ? numericOffset
            : 0;
    return {
        success: envelope.success === true,
        error: envelope.error === true || envelope.success === false,
        message:
            typeof envelope.message === "string" ? envelope.message : undefined,
        statusCode: Number.isFinite(Number(envelope.status_code))
            ? Number(envelope.status_code)
            : undefined,
        errorCode:
            typeof envelope.error_code === "string"
                ? envelope.error_code
                : undefined,
        results,
        total,
        offset,
        hasMore: envelope.has_more === true || offset + results.length < total,
    };
}

function trademarkSearchIsRateLimited(page: TrademarkEnvelope): boolean {
    return (
        page.statusCode === 429 ||
        /(?:HTTP\s*429|too many requests|rate.?limit|throttl)/i.test(
            page.message ?? "",
        )
    );
}

function trademarkSearchRejectedPhrase(page: TrademarkEnvelope): boolean {
    return (
        page.statusCode === 400 ||
        /(?:HTTP\s*400|bad request|invalid query)/i.test(page.message ?? "")
    );
}

function trademarkToolResponse(response: Record<string, unknown>): unknown {
    return {
        // The structured payload is what the model consumes. Do not repeat it
        // in `content`: result serialization includes both fields, and the
        // duplicate used to push otherwise complete portfolios over the size
        // limit.
        content: [
            {
                type: "text",
                text: "Exact trademark-owner results are in structuredContent.",
            },
        ],
        structuredContent: response,
    };
}

type TrademarkSearchOptions = {
    sleep?: (milliseconds: number) => Promise<void>;
};

const defaultSleep = (milliseconds: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

/**
 * Normalize harmless legal-name presentation differences (punctuation,
 * "&" vs "and", spacing, case) without conflating distinct entities.
 */
export function normalizeTrademarkOwnerName(value: string): string {
    return value
        .normalize("NFKC")
        .replace(/&/g, " AND ")
        .replace(/[’'.,]/g, "")
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim()
        .replace(/\s+/g, " ")
        .toUpperCase();
}

function ownerStrings(
    record: Record<string, unknown>,
    key: string,
): string[] {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return [value.trim()];
    if (Array.isArray(value)) {
        return value
            .filter((item): item is string => typeof item === "string")
            .map((item) => item.trim())
            .filter(Boolean);
    }
    return [];
}

export function trademarkRecordOwnerNames(
    record: Record<string, unknown>,
): string[] {
    const ownerNames = [
        ...ownerStrings(record, "ownerName"),
        ...ownerStrings(record, "owner_name"),
    ].map((name) => name.replace(/\s+\([^)]*\)\s*$/, "").trim());
    if (ownerNames.length) return [...new Set(ownerNames)];
    return [
        ...ownerStrings(record, "ownerFullText"),
        ...ownerStrings(record, "owner_full_text"),
    ];
}

export function trademarkRecordMatchesExactOwner(
    record: Record<string, unknown>,
    ownerName: string,
): boolean {
    const expected = normalizeTrademarkOwnerName(ownerName);
    return (
        !!expected &&
        trademarkRecordOwnerNames(record).some(
            (candidate) => normalizeTrademarkOwnerName(candidate) === expected,
        )
    );
}

function escapeElasticsearchPhrase(value: string): string {
    return value.replace(/([\\"])/g, "\\$1");
}

function firstDefined(
    record: Record<string, unknown>,
    keys: string[],
): unknown {
    for (const key of keys) {
        if (record[key] !== undefined && record[key] !== null)
            return record[key];
    }
    return undefined;
}

function compactStrings(
    value: unknown,
    maxItems = 8,
    maxLength = 180,
): unknown {
    const compact = (item: string) =>
        item.length <= maxLength ? item : `${item.slice(0, maxLength - 1)}…`;
    if (typeof value === "string") return compact(value.trim());
    if (Array.isArray(value)) {
        const strings = value
            .filter((item): item is string => typeof item === "string")
            .map((item) => compact(item.trim()))
            .filter(Boolean)
            .slice(0, maxItems);
        return strings.length ? strings : undefined;
    }
    return undefined;
}

/**
 * Project a verbose tmsearch hit into the fields needed for a portfolio
 * workbook. This preserves one row per mark while preventing long index-only
 * fields from causing the final tool response to be truncated.
 */
export function compactTrademarkPortfolioRecord(
    record: Record<string, unknown>,
): Record<string, unknown> {
    const fields: Array<[string, unknown]> = [
        [
            "serial_number",
            firstDefined(record, ["serialNumber", "serial_number", "id"]),
        ],
        [
            "registration_number",
            firstDefined(record, [
                "registrationNumber",
                "registration_number",
                "registrationId",
                "registration_id",
            ]),
        ],
        ["mark", firstDefined(record, ["wordmark", "markText", "mark_text"])],
        [
            "owner_names",
            compactStrings(
                firstDefined(record, ["ownerName", "owner_name"]),
                4,
                180,
            ),
        ],
        ["live", firstDefined(record, ["alive", "live"])],
        [
            "status",
            compactStrings(
                firstDefined(record, [
                    "statusDescription",
                    "status_description",
                    "status",
                ]),
                1,
                180,
            ),
        ],
        ["status_code", firstDefined(record, ["statusCode", "status_code"])],
        ["mark_type", firstDefined(record, ["markType", "mark_type"])],
        [
            "international_classes",
            compactStrings(
                firstDefined(record, [
                    "internationalClass",
                    "internationalClasses",
                    "international_class",
                ]),
                45,
                24,
            ),
        ],
        ["filing_date", firstDefined(record, ["filingDate", "filing_date"])],
        [
            "registration_date",
            firstDefined(record, ["registrationDate", "registration_date"]),
        ],
        [
            "publication_date",
            firstDefined(record, ["publicationDate", "publication_date"]),
        ],
        [
            "abandon_date",
            firstDefined(record, ["abandonDate", "abandon_date"]),
        ],
        [
            "cancellation_date",
            firstDefined(record, ["cancellationDate", "cancellation_date"]),
        ],
        [
            "expiration_date",
            firstDefined(record, ["expirationDate", "expiration_date"]),
        ],
        [
            "goods_services_summary",
            compactStrings(
                firstDefined(record, ["goodsAndServices", "goods_services"]),
                3,
                180,
            ),
        ],
    ];
    return Object.fromEntries(
        fields.filter(([, value]) => value !== undefined && value !== ""),
    );
}

export function exactOwnerCandidateArgs(
    args: Record<string, unknown>,
    ownerName: string,
    offset: number,
    useOwnerPhraseQuery = true,
    limit = OWNER_SEARCH_PAGE_SIZE,
): Record<string, unknown> {
    const next: Record<string, unknown> = {
        ...args,
        owner_name: ownerName,
        offset,
        limit: Math.min(OWNER_SEARCH_PAGE_SIZE, Math.max(1, limit)),
    };
    delete next.owner_names;
    if (useOwnerPhraseQuery) {
        next.query = `ownerFullText:"${escapeElasticsearchPhrase(ownerName)}"`;
    } else {
        delete next.query;
    }
    return next;
}

export function exactOwnerSearchResponse(input: {
    ownerName: string;
    records: Array<Record<string, unknown>>;
    requestedOffset: number;
    requestedLimit: number;
    candidatesExamined: number;
    upstreamTotal: number;
    exhaustive: boolean;
    usedPhraseQuery: boolean;
}): Record<string, unknown> {
    const matches = input.records.filter((record) =>
        trademarkRecordMatchesExactOwner(record, input.ownerName),
    );
    const results = matches
        .slice(
            input.requestedOffset,
            input.requestedOffset + input.requestedLimit,
        )
        .map(compactTrademarkPortfolioRecord);
    const hasMore =
        input.requestedOffset + results.length < matches.length ||
        !input.exhaustive;
    return {
        success: true,
        source: "tmsearch",
        count: results.length,
        total: matches.length,
        offset: input.requestedOffset,
        limit: input.requestedLimit,
        has_more: hasMore,
        results,
        metadata: {
            match_mode: "exact_normalized_current_owner",
            owner_name: input.ownerName,
            candidates_examined: input.candidatesExamined,
            upstream_candidate_total: input.upstreamTotal,
            exhaustive: input.exhaustive,
            owner_phrase_query_supported: input.usedPhraseQuery,
            result_projection: "compact_portfolio",
            ...(input.exhaustive
                ? {}
                : {
                      warning: `The USPTO candidate set exceeded Mike's ${MAX_EXACT_OWNER_CANDIDATES}-record safety limit. Returned records are exact owner-name matches, but the portfolio may be incomplete.`,
                  }),
        },
    };
}

export async function executeExactTrademarkOwnerSearch(
    callTool: (args: Record<string, unknown>) => Promise<unknown>,
    args: Record<string, unknown>,
    ownerName: string,
    options: TrademarkSearchOptions = {},
): Promise<unknown> {
    const sleep = options.sleep ?? defaultSleep;
    const rawLimit = args.limit == null ? Number.NaN : Number(args.limit);
    const requestedLimit = Number.isFinite(rawLimit)
        ? Math.min(100, Math.max(1, Math.trunc(rawLimit)))
        : 100;
    const rawOffset = Number(args.offset);
    const requestedOffset = Number.isFinite(rawOffset)
        ? Math.max(0, Math.trunc(rawOffset))
        : 0;
    const records: Array<Record<string, unknown>> = [];
    const seen = new Set<string>();
    let candidateOffset = 0;
    let candidatesExamined = 0;
    let upstreamTotal = 0;
    let exhaustive = false;
    let useOwnerPhraseQuery = true;

    while (candidatesExamined < MAX_EXACT_OWNER_CANDIDATES) {
        if (candidateOffset > 0) await sleep(OWNER_SEARCH_PAGE_INTERVAL_MS);
        const remainingCandidates =
            MAX_EXACT_OWNER_CANDIDATES - candidatesExamined;
        const candidateArgs = exactOwnerCandidateArgs(
            args,
            ownerName,
            candidateOffset,
            useOwnerPhraseQuery,
            remainingCandidates,
        );
        let result: unknown;
        let page: TrademarkEnvelope;
        let rateLimitRetries = 0;
        while (true) {
            result = await callTool(candidateArgs);
            page = parseTrademarkToolResult(result);
            if (
                !page.error ||
                !trademarkSearchIsRateLimited(page) ||
                rateLimitRetries >= TRADEMARK_RATE_LIMIT_MAX_RETRIES
            ) {
                break;
            }
            await sleep(
                Math.min(
                    TRADEMARK_RATE_LIMIT_MAX_DELAY_MS,
                    TRADEMARK_RATE_LIMIT_BASE_DELAY_MS * 2 ** rateLimitRetries,
                ),
            );
            rateLimitRetries += 1;
        }
        if (page.error) {
            if (
                useOwnerPhraseQuery &&
                candidateOffset === 0 &&
                trademarkSearchRejectedPhrase(page)
            ) {
                // Some tmsearch deployments reject explicit Elasticsearch
                // field syntax. The connector owner match still supplies
                // candidates; local exact filtering prevents false positives
                // in the returned records.
                useOwnerPhraseQuery = false;
                continue;
            }
            const partial = records.length
                ? exactOwnerSearchResponse({
                      ownerName,
                      records,
                      requestedOffset,
                      requestedLimit,
                      candidatesExamined,
                      upstreamTotal,
                      exhaustive: false,
                      usedPhraseQuery: useOwnerPhraseQuery,
                  })
                : {};
            return trademarkToolResponse({
                ...partial,
                success: false,
                error: true,
                source: "tmsearch",
                owner_name: ownerName,
                message: page.message ?? "Trademark search failed.",
                ...(page.statusCode == null
                    ? {}
                    : { status_code: page.statusCode }),
                ...(page.errorCode == null
                    ? {}
                    : { error_code: page.errorCode }),
                metadata: {
                    ...((partial.metadata as
                        | Record<string, unknown>
                        | undefined) ?? {}),
                    rate_limit_retries: rateLimitRetries,
                    retryable: trademarkSearchIsRateLimited(page),
                    ...(trademarkSearchIsRateLimited(page)
                        ? {
                              retry_after_seconds:
                                  TRADEMARK_RATE_LIMIT_RETRY_AFTER_SECONDS,
                              next_required_action:
                                  "Stop TMSEARCH calls for this response. Preserve completed results and retry this owner in a new request after the cooldown.",
                          }
                        : {}),
                },
            });
        }

        upstreamTotal = Math.max(upstreamTotal, page.total);
        candidatesExamined += page.results.length;
        for (const record of page.results) {
            const identifier = String(
                record.id ??
                    record.serialNumber ??
                    record.serial_number ??
                    JSON.stringify(record),
            );
            if (seen.has(identifier)) continue;
            seen.add(identifier);
            records.push(record);
        }

        candidateOffset += page.results.length;
        if (!page.hasMore || candidateOffset >= page.total) {
            exhaustive = true;
            break;
        }
        if (!page.results.length) break;
    }

    const response = exactOwnerSearchResponse({
        ownerName,
        records,
        requestedOffset,
        requestedLimit,
        candidatesExamined,
        upstreamTotal,
        exhaustive,
        usedPhraseQuery: useOwnerPhraseQuery,
    });
    return trademarkToolResponse(response);
}

export function exactTrademarkOwnerNames(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const seen = new Set<string>();
    const names: string[] = [];
    for (const item of value) {
        if (typeof item !== "string") continue;
        const name = item.trim();
        const normalized = normalizeTrademarkOwnerName(name);
        if (!name || !normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        names.push(name);
        if (names.length === MAX_EXACT_OWNER_BATCH_SIZE) break;
    }
    return names;
}

export async function executeExactTrademarkOwnerBatchSearch(
    callTool: (args: Record<string, unknown>) => Promise<unknown>,
    args: Record<string, unknown>,
    ownerNames: string[],
    options: TrademarkSearchOptions = {},
): Promise<unknown> {
    const sleep = options.sleep ?? defaultSleep;
    const portfolios: Array<Record<string, unknown>> = new Array(
        ownerNames.length,
    );
    for (const [index, ownerName] of ownerNames.entries()) {
        if (index > 0) await sleep(OWNER_SEARCH_BATCH_INTERVAL_MS);
        try {
            const result = (await executeExactTrademarkOwnerSearch(
                callTool,
                { ...args, owner_name: ownerName },
                ownerName,
                { sleep },
            )) as { structuredContent?: Record<string, unknown> };
            portfolios[index] =
                result.structuredContent ??
                ({
                    success: false,
                    owner_name: ownerName,
                    message: "Trademark search returned no structured result.",
                } as Record<string, unknown>);
            if (
                Number(portfolios[index].status_code) === 429 ||
                /(?:HTTP\s*429|too many requests|rate.?limit|throttl)/i.test(
                    String(portfolios[index].message ?? ""),
                )
            ) {
                for (
                    let deferred = index + 1;
                    deferred < ownerNames.length;
                    deferred += 1
                ) {
                    portfolios[deferred] = {
                        success: false,
                        error: true,
                        owner_name: ownerNames[deferred],
                        deferred: true,
                        message:
                            "Search deferred because the USPTO TMSEARCH backend remains rate-limited. Retry this owner later.",
                        status_code: 429,
                        metadata: {
                            retryable: true,
                            rate_limit_retries: 0,
                            retry_after_seconds:
                                TRADEMARK_RATE_LIMIT_RETRY_AFTER_SECONDS,
                        },
                    };
                }
                break;
            }
        } catch (error) {
            portfolios[index] = {
                success: false,
                owner_name: ownerName,
                message:
                    error instanceof Error
                        ? error.message
                        : "Trademark search failed.",
            };
        }
    }

    const totalMarks = portfolios.reduce((total, portfolio) => {
        const count = Number(portfolio.count);
        return total + (Number.isFinite(count) && count > 0 ? count : 0);
    }, 0);
    const failedOwners = portfolios.filter(
        (portfolio) => portfolio.success !== true,
    ).length;
    const failedOwnerNames = portfolios.flatMap((portfolio, index) =>
        portfolio.success === true ? [] : [ownerNames[index]],
    );
    const response = {
        success: failedOwners < portfolios.length,
        source: "tmsearch",
        match_mode: "exact_normalized_current_owner_batch",
        owner_count: ownerNames.length,
        failed_owner_count: failedOwners,
        failed_owner_names: failedOwnerNames,
        count: totalMarks,
        portfolios,
        metadata: {
            request_mode: "paced_serial",
            request_interval_ms: OWNER_SEARCH_BATCH_INTERVAL_MS,
            page_size: OWNER_SEARCH_PAGE_SIZE,
            page_interval_ms: OWNER_SEARCH_PAGE_INTERVAL_MS,
            max_owner_batch_size: MAX_EXACT_OWNER_BATCH_SIZE,
            ...(failedOwnerNames.length
                ? {
                      retry_guidance: `Stop TMSEARCH calls for this response. Wait at least ${TRADEMARK_RATE_LIMIT_RETRY_AFTER_SECONDS} seconds, then retry only failed_owner_names in a new request; completed owner portfolios are valid and do not need to be searched again.`,
                      retry_after_seconds:
                          TRADEMARK_RATE_LIMIT_RETRY_AFTER_SECONDS,
                  }
                : {}),
        },
    };
    return trademarkToolResponse(response);
}

export function managedTrademarkToolSchema(
    schema: Record<string, unknown>,
): Record<string, unknown> {
    const properties =
        schema.properties &&
        typeof schema.properties === "object" &&
        !Array.isArray(schema.properties)
            ? { ...(schema.properties as Record<string, unknown>) }
            : {};
    const ownerProperty =
        properties.owner_name &&
        typeof properties.owner_name === "object" &&
        !Array.isArray(properties.owner_name)
            ? (properties.owner_name as Record<string, unknown>)
            : { type: "string" };
    properties.owner_name = {
        ...ownerProperty,
        description:
            "Exact current owner/applicant legal name. Use this for owner portfolios; Mike searches the owner field, pages candidates, and returns up to 100 normalized exact ownerName matches by default in a compact, complete portfolio format. Do not put an owner name in query.",
    };
    properties.owner_names = {
        // Plain "array", not ["array", "null"]: Google's tool-schema
        // conversion lowers union types to anyOf branches that lose their
        // items schema, so every Gemini call fails validation. Omission
        // already covers null.
        type: "array",
        items: { type: "string" },
        minItems: 1,
        maxItems: MAX_EXACT_OWNER_BATCH_SIZE,
        description:
            "Complete legal names for a bulk exact-owner portfolio search. When searching two or more owners, put up to 10 names here in one tool call instead of making separate calls. Each owner returns up to 100 marks by default in a compact, complete portfolio format. Do not also use owner_name or query. If a response reports HTTP 429 or failed_owner_names, stop trademark calls for that response and resume only the failed owners after the reported cooldown.",
    };
    const limitProperty =
        properties.limit &&
        typeof properties.limit === "object" &&
        !Array.isArray(properties.limit)
            ? (properties.limit as Record<string, unknown>)
            : { type: "integer" };
    properties.limit = {
        ...limitProperty,
        description:
            "Maximum records to return. For an exact owner_name or owner_names portfolio, omit this value to receive up to 100 marks per owner; use offset for larger portfolios.",
    };
    return { ...schema, properties };
}
