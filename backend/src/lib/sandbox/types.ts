/** A document mounted for a run: spreadsheets carry their bytes, everything else its text. */
export type SandboxDoc = {
    doc_id: string;
    filename: string;
    file_type: string;
    bytes?: string;
    text: string;
};

export type PythonRequest = { code: string; docs: SandboxDoc[] };

export type PythonOutput = { name: string; columns: string[]; rows: unknown[][] };

export type PythonFailureCode =
    | "timeout"
    | "memory"
    | "output_too_large"
    | "busy"
    | "unavailable"
    | "crashed";

export type PythonRunOutcome =
    | {
          ok: true;
          stdout: string;
          stdoutTruncated: boolean;
          result?: unknown;
          outputs: PythonOutput[];
          durationMs: number;
      }
    | { ok: false; code: "python_error"; traceback: string; stdout: string }
    | { ok: false; code: PythonFailureCode };

export type RenderFormat = "pdf" | "blocks" | "check";

export type RenderRequest = { html: string; format: RenderFormat };

export type RenderFailureCode = "render_unavailable" | "render_busy" | "render_timeout" | "render_failed";

type RenderFailure = { ok: false; code: RenderFailureCode };

export type PdfOutcome = { ok: true; bytes: Buffer } | RenderFailure;

/** The page loaded like a render, reporting what its scripts threw. */
export type CheckOutcome = { ok: true; errors: string[] } | RenderFailure;

export type Run = { text: string; strike?: true; underline?: true; bold?: true };

export type VisualText = string | Run[];

export type VisualBlock =
    | { type: "heading"; level: 1 | 2 | 3; text: string }
    | { type: "paragraph"; text: VisualText; bullet?: number; style?: "small" | "caption" }
    | { type: "table"; rows: VisualText[][]; header: boolean; numeric: boolean[] }
    | { type: "image"; png: Buffer; widthPx: number; heightPx: number; alt: string };

export type BlocksOutcome = { ok: true; blocks: VisualBlock[] } | RenderFailure;

export type RenderOutcome = PdfOutcome | BlocksOutcome | CheckOutcome;

export type SandboxCapabilities = { python: boolean; render: boolean };

export interface SandboxClient {
    runPython(req: PythonRequest, opts?: { signal?: AbortSignal }): Promise<PythonRunOutcome>;
    render(req: { html: string; format: "pdf" }): Promise<PdfOutcome>;
    render(req: { html: string; format: "blocks" }): Promise<BlocksOutcome>;
    render(req: { html: string; format: "check" }): Promise<CheckOutcome>;
    render(req: RenderRequest): Promise<RenderOutcome>;
    capabilities(): Promise<SandboxCapabilities>;
}
