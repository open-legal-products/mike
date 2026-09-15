import { describe, expect, it, vi } from "vitest";
import type { StreamChatParams } from "../../llm";
import {
  buildMemoryCuratorTranscript,
  loadEligibleMemoryMessages,
  MEMORY_CURATOR_WRITE_TOOL,
  memoryCuratorModelForChat,
  matchesLatestConversationActivity,
  runMemoryCuratorScope,
  type CuratorScopeServices,
  type MemoryCuratorStoredMessage,
} from "../../../modules/memory/memory.curator";
import {
  MemoryRevisionConflictError,
  type MemoryFileRow,
} from "../files";

describe("memory curator model selection", () => {
  it("prefers the environment override, then the user's memory preference", () => {
    expect(
      memoryCuratorModelForChat({
        chatModel: "gpt-5.6-sol",
        memoryCuratorModel: "gpt-5.6-luna",
        environmentOverride: " claude-haiku-4-5 ",
      }),
    ).toBe("claude-haiku-4-5");

    expect(
      memoryCuratorModelForChat({
        chatModel: "gpt-5.6-sol",
        memoryCuratorModel: "gpt-5.6-luna",
      }),
    ).toBe("gpt-5.6-luna");
  });

  it("falls back to the conversation's selected chat model", () => {
    expect(
      memoryCuratorModelForChat({
        chatModel: "gpt-5.6-sol",
      }),
    ).toBe("gpt-5.6-sol");
  });
});

function row(
  id: string,
  role: "user" | "assistant",
  content: unknown,
  authorUserId: string | null,
  options: {
    inputId?: string | null;
    eligibleAt?: string | null;
    createdAt?: string;
  } = {},
): MemoryCuratorStoredMessage {
  return {
    id,
    role,
    content,
    author_user_id: authorUserId,
    memory_input_message_id: options.inputId ?? null,
    memory_eligible_at: options.eligibleAt ?? null,
    memory_app_eligible_at: options.eligibleAt ?? null,
    created_at: options.createdAt ?? "2026-09-05T00:00:00.000Z",
  };
}

describe("memory curator transcript isolation", () => {
  const messages = [
    row("1", "user", "Other member fact", "other-user"),
    row(
      "2",
      "assistant",
      [{ type: "content", text: "Other response" }],
      "other-user",
      { inputId: "1", eligibleAt: "2026-09-05T00:00:01.000Z" },
    ),
    row("3", "user", "My stable preference", "current-user"),
    row(
      "4",
      "assistant",
      [
        { type: "doc_read", filename: "secret.pdf" },
        { type: "content", text: "Current response" },
        {
          type: "ask_inputs_response",
          author_user_id: "current-user",
          responses: [
            {
              kind: "text",
              question: "Preferred drafting style?",
              answer: "Use short clauses",
            },
            { kind: "documents", filenames: ["private.pdf"] },
          ],
        },
        { type: "content", text: "Continuation response" },
      ],
      "current-user",
      { inputId: "3", eligibleAt: "2026-09-05T00:00:02.000Z" },
    ),
    row("5", "user", "Legacy unattributed text", null),
    row("6", "assistant", [{ type: "content", text: "Legacy response" }], null),
  ];

  it("keeps app evidence limited to the scheduling user's attributed turns", () => {
    const transcript = buildMemoryCuratorTranscript(
      messages,
      "current-user",
      "user",
    );
    expect(transcript).toContain("User: My stable preference");
    expect(transcript).toContain("Assistant: Current response");
    expect(transcript).toContain("Use short clauses");
    expect(transcript).toContain("Assistant: Continuation response");
    expect(transcript).not.toContain("Other member fact");
    expect(transcript).not.toContain("Legacy unattributed text");
    expect(transcript).not.toContain("secret.pdf");
    expect(transcript).not.toContain("private.pdf");
  });

  it("allows attributed collaborator turns into shared project evidence", () => {
    const transcript = buildMemoryCuratorTranscript(
      messages,
      "current-user",
      "project",
    );
    expect(transcript).toContain("Project member: Other member fact");
    expect(transcript).toContain("Project member: My stable preference");
    expect(transcript).toContain("Use short clauses");
    expect(transcript).not.toContain("Legacy unattributed text");
  });

  it("excludes another collaborator's ask-input response from app memory", () => {
    const transcript = buildMemoryCuratorTranscript(
      [
        row("0", "user", "Other prompt", "other-user"),
        row(
          "1",
          "assistant",
          [
            {
              type: "ask_inputs_response",
              author_user_id: "other-user",
              responses: [{ kind: "text", answer: "Other private fact" }],
            },
          ],
          "other-user",
          { inputId: "0", eligibleAt: "2026-09-05T00:00:01.000Z" },
        ),
      ],
      "current-user",
      "user",
    );
    expect(transcript).not.toContain("Other private fact");
  });

  it("keeps a collaborator's own ask-input answer without importing the original actor's turn", () => {
    const transcript = buildMemoryCuratorTranscript(
      [
        row("0", "user", "Original member prompt", "other-user"),
        row(
          "1",
          "assistant",
          [
            { type: "content", text: "Original response" },
            {
              type: "ask_inputs_response",
              author_user_id: "current-user",
              responses: [
                { kind: "text", answer: "My durable preference" },
              ],
            },
            { type: "content", text: "Continuation response" },
          ],
          "other-user",
          { inputId: "0", eligibleAt: "2026-09-05T00:00:01.000Z" },
        ),
      ],
      "current-user",
      "user",
    );
    expect(transcript).toContain("My durable preference");
    expect(transcript).toContain("Continuation response");
    expect(transcript).not.toContain("Original member prompt");
    expect(transcript).not.toContain("Original response");
  });

  it("never revives a failed or cancelled turn during a later successful scan", () => {
    const transcript = buildMemoryCuratorTranscript(
      [
        row("1", "user", "Remember my cancelled secret", "current-user"),
        row(
          "2",
          "assistant",
          [{ type: "content", text: "Cancelled by user" }],
          "current-user",
          { inputId: "1" },
        ),
        row("3", "user", "Use concise answers", "current-user"),
        row(
          "4",
          "assistant",
          [{ type: "content", text: "Understood" }],
          "current-user",
          { inputId: "3", eligibleAt: "2026-09-05T00:01:00.000Z" },
        ),
      ],
      "current-user",
      "user",
      { terminalTurnId: "4" },
    );
    expect(transcript).toContain("Use concise answers");
    expect(transcript).not.toContain("cancelled secret");
    expect(transcript).not.toContain("Cancelled by user");
  });

  it("uses an exclusive, microsecond-precise learning cutoff", () => {
    const messagesAtBoundary = [
      row("1", "user", "Too old", "current-user", {
        createdAt: "2026-09-05T00:00:00.000499+00:00",
      }),
      row("2", "assistant", "Old response", "current-user", {
        inputId: "1",
        eligibleAt: "2026-09-05T00:00:01.000000+00:00",
        createdAt: "2026-09-05T00:00:01.000000+00:00",
      }),
      row("3", "user", "New fact", "current-user", {
        createdAt: "2026-09-05T00:00:00.000501+00:00",
      }),
      row("4", "assistant", "New response", "current-user", {
        inputId: "3",
        eligibleAt: "2026-09-05T00:00:02.000000+00:00",
        createdAt: "2026-09-05T00:00:02.000000+00:00",
      }),
    ];
    const transcript = buildMemoryCuratorTranscript(
      messagesAtBoundary,
      "current-user",
      "user",
      { learningCutoffAt: "2026-09-05T00:00:00.000500+00:00" },
    );
    expect(transcript).not.toContain("Too old");
    expect(transcript).toContain("New fact");
  });

  it("loads successful pairs before applying the cap so failed turns cannot crowd them out", async () => {
    const sourceRows: MemoryCuratorStoredMessage[] = [
      row("input-ok", "user", "Durable preference", "current-user", {
        createdAt: "2026-09-05T00:00:00.000000Z",
      }),
      row("assistant-ok", "assistant", "Confirmed", "current-user", {
        inputId: "input-ok",
        eligibleAt: "2026-09-05T00:00:01.000000Z",
        createdAt: "2026-09-05T00:00:01.000000Z",
      }),
      ...Array.from({ length: 121 }, (_, index) =>
        row(
          `failed-${index.toString().padStart(3, "0")}`,
          "assistant",
          "Cancelled by user",
          "current-user",
          {
            inputId: "input-ok",
            createdAt: `2026-09-05T00:01:${String(index % 60).padStart(2, "0")}.${String(index).padStart(3, "0")}Z`,
          },
        ),
      ),
    ];
    const db = {
      from: () => {
        let selected = [...sourceRows];
        let limit = Number.POSITIVE_INFINITY;
        const builder = {
          select: () => builder,
          eq: (column: keyof MemoryCuratorStoredMessage | "chat_id", value: unknown) => {
            if (column !== "chat_id") {
              selected = selected.filter((candidate) => candidate[column] === value);
            }
            return builder;
          },
          not: (column: keyof MemoryCuratorStoredMessage, operator: string, value: unknown) => {
            if (operator === "is" && value === null) {
              selected = selected.filter((candidate) => candidate[column] != null);
            }
            return builder;
          },
          in: (column: keyof MemoryCuratorStoredMessage, values: unknown[]) => {
            selected = selected.filter((candidate) => values.includes(candidate[column]));
            return builder;
          },
          contains: (
            column: keyof MemoryCuratorStoredMessage,
            filter: unknown,
          ) => {
            // postgrest-js only sends a jsonb containment filter verbatim when
            // it is given a string; an array becomes a PostgREST array literal
            // that Postgres rejects on a jsonb column. Fail here rather than
            // let that reach a real database.
            expect(typeof filter).toBe("string");
            const values = JSON.parse(filter as string) as Array<
              Record<string, unknown>
            >;
            selected = selected.filter((candidate) => {
              if (column !== "content" || !Array.isArray(candidate.content)) {
                return false;
              }
              const events = candidate.content as unknown[];
              return values.every((expected) =>
                events.some(
                  (event) =>
                    !!event &&
                    typeof event === "object" &&
                    Object.entries(expected).every(
                      ([key, value]) =>
                        (event as Record<string, unknown>)[key] === value,
                    ),
                ),
              );
            });
            return builder;
          },
          order: (column: keyof MemoryCuratorStoredMessage, options: { ascending: boolean }) => {
            selected.sort((left, right) =>
              String(left[column]).localeCompare(String(right[column])) *
              (options.ascending ? 1 : -1),
            );
            return builder;
          },
          limit: (value: number) => {
            limit = value;
            return builder;
          },
          then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
            Promise.resolve({ data: selected.slice(0, limit), error: null }).then(
              resolve,
              reject,
            ),
        };
        return builder;
      },
    };

    const loaded = await loadEligibleMemoryMessages(
      db as never,
      "chat_messages",
      "chat-1",
      "current-user",
    );
    expect(loaded.map((message) => message.id)).toEqual([
      "input-ok",
      "assistant-ok",
    ]);
  });
});

function file(scope: "user" | "project" = "user"): MemoryFileRow {
  return {
    id: "memory-file",
    scope,
    user_id: scope === "user" ? "actor" : null,
    project_id: scope === "project" ? "project" : null,
    enabled: true,
    epoch: 7,
    revision: 1,
    // The row's own body is not what the curator reads — `args()` hands it the
    // current content separately — but MemoryFileRow carries it, so the
    // fixture has to be a complete row rather than the subset the tests touch.
    content: "",
    content_sha256: null,
    size_bytes: 0,
    last_source_job_id: null,
    status: "processing",
    last_error_code: null,
    learning_cutoff_at: "2026-09-05T00:00:00.000Z",
    last_source: null,
    updated_by: null,
    created_at: "2026-09-05T00:00:00.000Z",
    updated_at: "2026-09-05T00:00:00.000Z",
  };
}

function args(scope: "user" | "project" = "user") {
  return {
    db: {} as never,
    file: file(scope),
    current: { content: "# Existing", revision: 1 },
    transcript: "User: Keep responses concise",
    model: "openai:gpt-test",
    apiKeys: {},
    actorUserId: "actor",
    actorEmail: "actor@example.com",
    stateId: "state",
    generation: 4,
    expectedEpoch: 7,
    sourceEpoch: 2,
    conversationGeneration: 11,
    surface: "chat" as const,
    conversationId: "chat",
    turnId: "turn",
    jobId: "job",
  };
}

// The return type keeps the vi.fn() identities visible alongside the service
// contract: casting straight to CuratorScopeServices (as this used to) erased
// them, so `svc.write.mock` did not type-check.
type CuratorScopeServiceMocks = CuratorScopeServices & {
  stream: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
};

function services(
  overrides: Partial<CuratorScopeServices> = {},
): CuratorScopeServiceMocks {
  return {
    stream: vi.fn(async () => ({ fullText: "" })),
    write: vi.fn(async () => ({
      applied: true,
      current: {
        enabled: true,
        content: "# Updated",
        revision: 2,
        hash: "hash",
        updated_at: "2026-09-05T00:01:00.000Z",
        updated_by: "actor",
        source: "curator" as const,
        status: "idle" as const,
      },
    })),
    checkProject: vi.fn(async () => ({
      ok: true as const,
      projectRole: "editor" as const,
      project: { id: "project" },
    })) as unknown as CuratorScopeServices["checkProject"],
    ...overrides,
  } as unknown as CuratorScopeServiceMocks;
}

describe("scope-bound memory curator tool", () => {
  it("exposes only complete Markdown and writes to the server-bound scope", async () => {
    const svc = services();
    svc.stream = vi.fn(async (params: StreamChatParams) => {
      await params.runTools?.([
        {
          id: "call-1",
          name: "write_memory_file",
          input: {
            expectedRevision: 1,
            markdown: "# Updated\n- Concise",
            changeSummary: "Remember concise response preference",
          },
        },
      ]);
      return { fullText: "" };
    });

    const result = await runMemoryCuratorScope(args(), svc);

    expect(result).toEqual({ outcome: "updated", revision: 2 });
    expect(svc.stream).toHaveBeenCalledWith(
      expect.objectContaining({
        requireTools: true,
        tools: [MEMORY_CURATOR_WRITE_TOOL],
      }),
    );
    expect(svc.write).toHaveBeenCalledWith(
      expect.objectContaining({
        file: expect.objectContaining({ id: "memory-file", scope: "user" }),
        content: "# Updated\n- Concise",
        expectedRevision: 1,
        expectedEpoch: 7,
        sourceEpoch: 2,
        conversationGeneration: 11,
        sourceJobId: "job",
      }),
    );
    // The tool still demands a rationale so the model has to justify the
    // rewrite, but nothing stores it: the file keeps only its current body.
    expect(svc.write.mock.calls[0]![0]).not.toHaveProperty("changeSummary");
    expect(
      Object.keys(
        MEMORY_CURATOR_WRITE_TOOL.function.parameters.properties as object,
      ),
    ).toEqual(["markdown", "expectedRevision", "changeSummary"]);
    expect(JSON.stringify(MEMORY_CURATOR_WRITE_TOOL)).not.toMatch(
      /owner|project_id|scope|storage_path/i,
    );
  });

  it("records no change when the model calls no tool", async () => {
    const svc = services();
    const result = await runMemoryCuratorScope(args(), svc);
    expect(result).toEqual({ outcome: "no_change", revision: 1 });
    expect(svc.write).not.toHaveBeenCalled();
  });

  it("re-checks canonical project edit access inside the tool", async () => {
    const svc = services({
      checkProject: vi.fn(async () => ({ ok: false as const, status: 404 })) as never,
    });
    svc.stream = vi.fn(async (params: StreamChatParams) => {
      await params.runTools?.([
        {
          id: "call-1",
          name: "write_memory_file",
          input: {
            expectedRevision: 1,
            markdown: "# Bad",
            changeSummary: "Bad update",
          },
        },
      ]);
      return { fullText: "" };
    });
    const result = await runMemoryCuratorScope(args("project"), svc);
    expect(result).toMatchObject({
      outcome: "skipped",
      reason: "access_revoked",
    });
    expect(svc.write).not.toHaveBeenCalled();
  });

  it("retries a concurrent edit so the next run rebases on latest memory", async () => {
    const svc = services({
      write: vi.fn(async () => {
        throw new MemoryRevisionConflictError("private raw conflict detail");
      }),
    });
    svc.stream = vi.fn(async (params: StreamChatParams) => {
      await params.runTools?.([
        {
          id: "call-1",
          name: "write_memory_file",
          input: {
            expectedRevision: 1,
            markdown: "# Next",
            changeSummary: "Rebase update",
          },
        },
      ]);
      return { fullText: "" };
    });
    await expect(runMemoryCuratorScope(args(), svc)).rejects.toThrow(
      "Memory curator scope failed",
    );
  });

  it("never lets raw provider errors escape into persisted DB job errors", async () => {
    const svc = services({
      stream: vi.fn(async () => {
        throw new Error("SECRET transcript and provider credential");
      }),
    });
    await expect(runMemoryCuratorScope(args(), svc)).rejects.toThrow(
      /^Memory curator scope failed$/,
    );
  });
});

describe("shared project inactivity debounce", () => {
  it("rejects an earlier actor's project token after another actor speaks", () => {
    expect(
      matchesLatestConversationActivity({
        scheduledGeneration: 8,
        latestGeneration: 9,
      }),
    ).toBe(false);
  });

  it("admits the conversation-global latest terminal turn", () => {
    expect(
      matchesLatestConversationActivity({
        scheduledGeneration: 9,
        latestGeneration: 9,
      }),
    ).toBe(true);
  });
});
