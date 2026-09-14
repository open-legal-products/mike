import { createHash } from "crypto";
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import JSZip, { type JSZipObject } from "jszip";
import { parse as parseYaml } from "yaml";

const DEFAULT_REPOSITORY = "Open-Legal-Products/mike-workflows";
const DEFAULT_REF = "main";
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const WORKFLOW_KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_ARCHIVE_BYTES = 10 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 50 * 1024 * 1024;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_WORKFLOWS = 1_000;
const MAX_ASSETS_PER_WORKFLOW = 50;
const DOWNLOAD_TIMEOUT_MS = 30_000;

const DEFAULT_QUICK_ACTION_PROMPT =
  "Execute this workflow on the selected documents.";
const DEFAULT_WORD_QUICK_ACTION_PROMPT =
  "Execute this workflow on this Word document.";
const DEFAULT_WORKFLOWS = [
  { key: "proofread", quickAction: true, wordQuickAction: true },
  { key: "compare-documents", quickAction: true, wordQuickAction: false },
  { key: "extract-key-terms", quickAction: true, wordQuickAction: true },
  { key: "draft-from-template", quickAction: true, wordQuickAction: true },
  {
    key: "commercial-agreement-tabular-review",
    quickAction: false,
    wordQuickAction: false,
  },
] as const;
const DEFAULT_WORKFLOW_BY_KEY = new Map<
  string,
  {
    key: string;
    quickAction: boolean;
    wordQuickAction: boolean;
    sortOrder: number;
  }
>(
  DEFAULT_WORKFLOWS.map((workflow, sortOrder) => [
    workflow.key,
    { ...workflow, sortOrder },
  ]),
);

type UnknownRecord = Record<string, unknown>;

export type WorkflowCatalogAssetSource = {
  filename: string;
  file_type: string;
  size_bytes: number;
  content_hash: string;
  temporary_path: string;
};

export type WorkflowCatalogSourceWorkflow = {
  workflow_key: string;
  distribution: "default" | "addon";
  version: string | null;
  title: string;
  description: string | null;
  type: "assistant" | "tabular";
  prompt_md: string;
  columns_config: unknown[] | null;
  contributors: Array<{
    name: string;
    organisation: string | null;
    role: string | null;
    linkedin: string | null;
  }>;
  language: string | null;
  practice: string | null;
  jurisdictions: string[] | null;
  pack_key: string | null;
  pack_title: string | null;
  pack_description: string | null;
  pack_version: string | null;
  default_sort_order: number | null;
  quick_action_name: string | null;
  quick_action_prompt: string | null;
  document_upload: boolean;
  word_quick_action: boolean;
  word_quick_action_prompt: string | null;
  assets: WorkflowCatalogAssetSource[];
  content_hash: string;
};

export type WorkflowCatalogSourceDocument = {
  source_repository: string;
  source_ref: string;
  source_commit: string;
  workflows: WorkflowCatalogSourceWorkflow[];
};

export type PreparedWorkflowCatalog = {
  directory: string;
  catalogPath: string;
  archivePath: string;
  sourceCommit: string;
};

export type WorkflowCatalogSourceOptions = {
  repository?: string;
  ref?: string;
  githubToken?: string;
  fetchImpl?: typeof fetch;
  temporaryRoot?: string;
};

type ParsedPack = {
  key: string;
  title: string;
  description: string;
  version: string;
  workflowNames: string[];
};

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function asRecord(value: unknown, label: string): UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as UnknownRecord;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value.trim() || null;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label} must be an array of strings`);
  }
  return value.map((item) => item.trim()).filter(Boolean);
}

function validateColumnsConfig(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a non-empty array`);
  }
  value.forEach((item, index) => {
    const column = asRecord(item, `${label}[${index}]`);
    if (!Number.isInteger(column.index)) {
      throw new Error(`${label}[${index}].index must be an integer`);
    }
    requiredString(column.name, `${label}[${index}].name`);
    requiredString(column.prompt, `${label}[${index}].prompt`);
    optionalString(column.format, `${label}[${index}].format`);
    if (column.tags !== undefined && column.tags !== null) {
      stringArray(column.tags, `${label}[${index}].tags`);
    }
  });
  return value;
}

function parseYamlObject(source: string, label: string): UnknownRecord {
  try {
    return asRecord(parseYaml(source), label);
  } catch (error) {
    throw new Error(
      `${label} is invalid YAML: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function parseSkill(source: string, label: string) {
  const normalized = source.replace(/\r\n/g, "\n");
  const match = normalized.match(/^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/);
  if (!match) throw new Error(`${label} must contain YAML frontmatter`);
  return {
    frontmatter: parseYamlObject(match[1], `${label} frontmatter`),
    body: match[2].trimEnd(),
  };
}

function githubHeaders(token?: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    "User-Agent": "mike-workflow-sync",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

function sourceConfiguration(options: WorkflowCatalogSourceOptions) {
  const repository =
    options.repository ??
    process.env.MIKE_WORKFLOWS_REPOSITORY ??
    DEFAULT_REPOSITORY;
  const ref = options.ref ?? process.env.MIKE_WORKFLOWS_REF ?? DEFAULT_REF;
  const githubToken =
    options.githubToken ?? process.env.MIKE_WORKFLOWS_GITHUB_TOKEN;
  if (!REPOSITORY_PATTERN.test(repository)) {
    throw new Error(
      "MIKE_WORKFLOWS_REPOSITORY must use the owner/repository form",
    );
  }
  if (!ref.trim() || ref.length > 200) {
    throw new Error("MIKE_WORKFLOWS_REF must be between 1 and 200 characters");
  }
  return { repository, ref, githubToken };
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
): Promise<Response> {
  return fetchImpl(url, {
    ...init,
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
}

export async function resolveWorkflowSourceCommit(
  options: WorkflowCatalogSourceOptions = {},
): Promise<{ repository: string; ref: string; commit: string }> {
  const { repository, ref, githubToken } = sourceConfiguration(options);
  if (COMMIT_PATTERN.test(ref)) return { repository, ref, commit: ref };
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchWithTimeout(
    `https://api.github.com/repos/${repository}/commits/${encodeURIComponent(ref)}`,
    { headers: githubHeaders(githubToken) },
    fetchImpl,
  );
  if (!response.ok) {
    throw new Error(
      `Could not resolve ${repository}@${ref}: GitHub returned ${response.status}`,
    );
  }
  const payload = asRecord(await response.json(), "GitHub commit response");
  const commit = requiredString(payload.sha, "GitHub commit SHA");
  if (!COMMIT_PATTERN.test(commit)) {
    throw new Error("GitHub returned an invalid workflow source commit SHA");
  }
  return { repository, ref, commit };
}

async function downloadArchive(
  archivePath: string,
  repository: string,
  commit: string,
  options: WorkflowCatalogSourceOptions,
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchWithTimeout(
    `https://codeload.github.com/${repository}/zip/${commit}`,
    { headers: githubHeaders(options.githubToken) },
    fetchImpl,
  );
  if (!response.ok) {
    throw new Error(
      `Could not download ${repository}@${commit}: GitHub returned ${response.status}`,
    );
  }
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_ARCHIVE_BYTES) {
    throw new Error(
      "SambaNova workflows archive exceeds the 10 MB compressed limit",
    );
  }
  if (!response.body) {
    throw new Error("GitHub returned an empty SambaNova workflows archive");
  }
  const archive = await open(archivePath, "wx", 0o600);
  const reader = response.body.getReader();
  let receivedBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > MAX_ARCHIVE_BYTES) {
        await reader.cancel();
        throw new Error(
          "SambaNova workflows archive exceeds the 10 MB compressed limit",
        );
      }
      let offset = 0;
      while (offset < value.byteLength) {
        const { bytesWritten } = await archive.write(
          value,
          offset,
          value.byteLength - offset,
        );
        if (bytesWritten === 0) {
          throw new Error("Could not write the SambaNova workflows archive");
        }
        offset += bytesWritten;
      }
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    await archive.close();
  }
}

function archiveFiles(zip: JSZip): Map<string, JSZipObject> {
  const entries = Object.values(zip.files).filter((entry) => !entry.dir);
  const first = entries[0]?.name;
  if (!first?.includes("/"))
    throw new Error("Workflow archive has no root directory");
  const root = first.slice(0, first.indexOf("/") + 1);
  const files = new Map<string, JSZipObject>();
  for (const entry of entries) {
    if (!entry.name.startsWith(root)) {
      throw new Error("Workflow archive contains multiple root directories");
    }
    const relative = entry.name.slice(root.length);
    if (
      !relative ||
      relative.startsWith("/") ||
      relative.split("/").includes("..")
    ) {
      throw new Error("Workflow archive contains an unsafe path");
    }
    files.set(relative, entry);
  }
  return files;
}

function declaredEntrySize(entry: JSZipObject): number | null {
  const data = (
    entry as JSZipObject & {
      _data?: { uncompressedSize?: unknown };
    }
  )._data;
  return typeof data?.uncompressedSize === "number"
    ? data.uncompressedSize
    : null;
}

async function parseArchive(
  archivePath: string,
  assetDirectory: string,
  repository: string,
  ref: string,
  commit: string,
): Promise<WorkflowCatalogSourceDocument> {
  const zip = await JSZip.loadAsync(await readFile(archivePath));
  const files = archiveFiles(zip);
  let extractedBytes = 0;
  const textCache = new Map<string, string>();

  async function readEntry(entryPath: string): Promise<Buffer> {
    const entry = files.get(entryPath);
    if (!entry) throw new Error(`Workflow archive is missing ${entryPath}`);
    const declared = declaredEntrySize(entry);
    if (declared !== null && declared > MAX_FILE_BYTES) {
      throw new Error(`${entryPath} exceeds the 5 MB per-file limit`);
    }
    const contents = await entry.async("nodebuffer");
    if (contents.byteLength > MAX_FILE_BYTES) {
      throw new Error(`${entryPath} exceeds the 5 MB per-file limit`);
    }
    extractedBytes += contents.byteLength;
    if (extractedBytes > MAX_EXTRACTED_BYTES) {
      throw new Error("Workflow archive exceeds the 50 MB extracted limit");
    }
    return contents;
  }

  async function readText(entryPath: string): Promise<string> {
    const cached = textCache.get(entryPath);
    if (cached !== undefined) return cached;
    const value = (await readEntry(entryPath)).toString("utf8");
    textCache.set(entryPath, value);
    return value;
  }

  const skillPaths = [...files.keys()]
    .filter(
      (entryPath) =>
        (entryPath.startsWith("assistant-workflows/") ||
          entryPath.startsWith("tabular-review-workflows/")) &&
        entryPath.endsWith("/SKILL.md"),
    )
    .sort((a, b) => a.localeCompare(b, "en"));
  if (!skillPaths.length)
    throw new Error("Workflow archive contains no workflows");
  if (skillPaths.length > MAX_WORKFLOWS) {
    throw new Error("Workflow archive exceeds the 1,000 workflow limit");
  }

  const packCache = new Map<string, ParsedPack>();
  const discoveredPackWorkflows = new Map<string, Set<string>>();
  const seenKeys = new Set<string>();
  const workflows: WorkflowCatalogSourceWorkflow[] = [];

  async function loadPack(
    collection: string,
    packDirectory: string,
    type: "assistant" | "tabular",
  ): Promise<ParsedPack> {
    const packPath = `${collection}/${packDirectory}/pack.yaml`;
    const cached = packCache.get(packPath);
    if (cached) return cached;
    const raw = parseYamlObject(await readText(packPath), packPath);
    const id = requiredString(raw.id, `${packPath}.id`);
    const pack = {
      key: `${type}:${id}`,
      title: requiredString(raw.title, `${packPath}.title`),
      description: requiredString(raw.description, `${packPath}.description`),
      version: requiredString(raw.version, `${packPath}.version`),
      workflowNames: stringArray(raw.workflows, `${packPath}.workflows`),
    };
    if (!pack.workflowNames.length) {
      throw new Error(`${packPath}.workflows must not be empty`);
    }
    if (
      pack.workflowNames.some((name) => !WORKFLOW_KEY_PATTERN.test(name)) ||
      new Set(pack.workflowNames).size !== pack.workflowNames.length
    ) {
      throw new Error(
        `${packPath}.workflows contains invalid or duplicate keys`,
      );
    }
    packCache.set(packPath, pack);
    return pack;
  }

  for (const skillPath of skillPaths) {
    const segments = skillPath.split("/");
    if (segments.length !== 3 && segments.length !== 4) {
      throw new Error(
        `${skillPath} has an unsupported workflow directory depth`,
      );
    }
    const collection = segments[0];
    let type: "assistant" | "tabular";
    if (collection === "assistant-workflows") type = "assistant";
    else if (collection === "tabular-review-workflows") type = "tabular";
    else throw new Error(`${skillPath} has an unsupported collection`);
    const workflowKey = segments.at(-2)!;
    if (!WORKFLOW_KEY_PATTERN.test(workflowKey)) {
      throw new Error(`${skillPath} has an invalid workflow key`);
    }
    if (seenKeys.has(workflowKey)) {
      throw new Error(
        `Workflow archive contains duplicate key '${workflowKey}'`,
      );
    }
    seenKeys.add(workflowKey);

    let pack: ParsedPack | null = null;
    if (segments.length === 4) {
      const packDirectory = segments[1];
      pack = await loadPack(collection, packDirectory, type);
      const packPath = `${collection}/${packDirectory}/pack.yaml`;
      const discovered =
        discoveredPackWorkflows.get(packPath) ?? new Set<string>();
      discovered.add(workflowKey);
      discoveredPackWorkflows.set(packPath, discovered);
      if (!pack.workflowNames.includes(workflowKey)) {
        throw new Error(
          `${packPath} does not list discovered workflow '${workflowKey}'`,
        );
      }
    }

    const { frontmatter, body } = parseSkill(
      await readText(skillPath),
      skillPath,
    );
    if (requiredString(frontmatter.name, `${skillPath}.name`) !== workflowKey) {
      throw new Error(`${skillPath}.name must match its directory`);
    }
    requiredString(frontmatter.license, `${skillPath}.license`);
    const metadata = asRecord(frontmatter.metadata, `${skillPath}.metadata`);
    const metadataType = requiredString(
      metadata["mike-type"],
      `${skillPath}.metadata.mike-type`,
    );
    if (metadataType !== type) {
      throw new Error(`${skillPath}.metadata.mike-type must be '${type}'`);
    }
    const availability = optionalString(
      metadata["mike-availability"],
      `${skillPath}.metadata.mike-availability`,
    );
    if (
      availability &&
      availability !== "system" &&
      availability !== "add-on"
    ) {
      throw new Error(`${skillPath}.metadata.mike-availability is invalid`);
    }

    const title = requiredString(
      metadata["mike-display-name"],
      `${skillPath}.metadata.mike-display-name`,
    );
    let prompt = body.trimStart();
    if (!prompt) throw new Error(`${skillPath} has no workflow instructions`);
    if (!prompt.startsWith("# ")) prompt = `# ${title}\n\n${prompt}`;

    let columnsConfig: unknown[] | null = null;
    if (type === "tabular") {
      const columnsPath = skillPath.replace(/SKILL\.md$/, "table-columns.yaml");
      const table = parseYamlObject(await readText(columnsPath), columnsPath);
      columnsConfig = validateColumnsConfig(
        table.columns,
        `${columnsPath}.columns`,
      );
    } else {
      const columnsPath = skillPath.replace(/SKILL\.md$/, "table-columns.yaml");
      if (files.has(columnsPath)) {
        throw new Error(
          `${columnsPath} is only supported for tabular workflows`,
        );
      }
    }

    const workflowDirectory = skillPath.slice(0, -"/SKILL.md".length);
    const assetPrefix = `${workflowDirectory}/assets/`;
    const assetPaths = [...files.keys()]
      .filter((entryPath) => {
        if (!entryPath.startsWith(assetPrefix)) return false;
        const filename = entryPath.slice(assetPrefix.length);
        return (
          !!filename && !filename.includes("/") && !filename.startsWith(".")
        );
      })
      .sort((a, b) => a.localeCompare(b, "en"));
    if (assetPaths.length > MAX_ASSETS_PER_WORKFLOW) {
      throw new Error(`${workflowKey} exceeds the 50 asset limit`);
    }
    const assets: WorkflowCatalogAssetSource[] = [];
    for (const [index, assetPath] of assetPaths.entries()) {
      const bytes = await readEntry(assetPath);
      const contentHash = sha256(bytes);
      const temporaryPath = path.join(
        assetDirectory,
        `${workflowKey}-${index}-${contentHash}`,
      );
      await writeFile(temporaryPath, bytes, { mode: 0o600 });
      const filename = assetPath.slice(assetPrefix.length);
      assets.push({
        filename,
        file_type: path.extname(filename).slice(1).toLowerCase() || "bin",
        size_bytes: bytes.byteLength,
        content_hash: contentHash,
        temporary_path: temporaryPath,
      });
    }

    const defaultConfig = DEFAULT_WORKFLOW_BY_KEY.get(workflowKey) ?? null;
    const jurisdictions = requiredString(
      metadata.jurisdictions,
      `${skillPath}.metadata.jurisdictions`,
    )
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    if (!jurisdictions.length) {
      throw new Error(`${skillPath}.metadata.jurisdictions must not be empty`);
    }
    const payload = {
      workflow_key: workflowKey,
      distribution: defaultConfig ? ("default" as const) : ("addon" as const),
      version: requiredString(
        metadata.version,
        `${skillPath}.metadata.version`,
      ),
      title,
      description: requiredString(
        frontmatter.description,
        `${skillPath}.description`,
      ),
      type,
      prompt_md: prompt,
      columns_config: columnsConfig,
      contributors: [
        {
          name: requiredString(metadata.author, `${skillPath}.metadata.author`),
          organisation: null,
          role: null,
          linkedin: null,
        },
      ],
      language: requiredString(
        metadata.language,
        `${skillPath}.metadata.language`,
      ),
      practice: requiredString(
        metadata.practice,
        `${skillPath}.metadata.practice`,
      ),
      jurisdictions,
      pack_key: pack?.key ?? null,
      pack_title: pack?.title ?? null,
      pack_description: pack?.description ?? null,
      pack_version: pack?.version ?? null,
      default_sort_order: defaultConfig?.sortOrder ?? null,
      quick_action_name: defaultConfig?.quickAction ? title : null,
      quick_action_prompt: defaultConfig?.quickAction
        ? DEFAULT_QUICK_ACTION_PROMPT
        : null,
      document_upload: defaultConfig?.quickAction === true,
      word_quick_action: defaultConfig?.wordQuickAction === true,
      word_quick_action_prompt: defaultConfig?.wordQuickAction
        ? DEFAULT_WORD_QUICK_ACTION_PROMPT
        : null,
      assets,
    };
    const hashPayload = {
      ...payload,
      assets: assets.map(({ temporary_path: _path, ...asset }) => asset),
    };
    workflows.push({
      ...payload,
      content_hash: sha256(JSON.stringify(hashPayload)),
    });
  }

  for (const workflow of DEFAULT_WORKFLOWS) {
    if (!seenKeys.has(workflow.key)) {
      throw new Error(
        `Workflow archive is missing required default '${workflow.key}'`,
      );
    }
  }

  for (const [packPath, pack] of packCache) {
    const discovered =
      discoveredPackWorkflows.get(packPath) ?? new Set<string>();
    for (const workflowName of pack.workflowNames) {
      if (!discovered.has(workflowName)) {
        throw new Error(`${packPath} lists missing workflow '${workflowName}'`);
      }
    }
  }

  return {
    source_repository: repository,
    source_ref: ref,
    source_commit: commit,
    workflows,
  };
}

export function validateWorkflowCatalogDocument(
  value: unknown,
): WorkflowCatalogSourceDocument {
  const document = asRecord(value, "Workflow catalog");
  const repository = requiredString(
    document.source_repository,
    "Workflow catalog source_repository",
  );
  if (!REPOSITORY_PATTERN.test(repository)) {
    throw new Error("Workflow catalog source_repository is invalid");
  }
  requiredString(document.source_ref, "Workflow catalog source_ref");
  const commit = requiredString(
    document.source_commit,
    "Workflow catalog source_commit",
  );
  if (!COMMIT_PATTERN.test(commit)) {
    throw new Error("Workflow catalog source_commit is invalid");
  }
  if (!Array.isArray(document.workflows) || !document.workflows.length) {
    throw new Error("Workflow catalog contains no workflows");
  }
  if (document.workflows.length > MAX_WORKFLOWS) {
    throw new Error("Workflow catalog exceeds the 1,000 workflow limit");
  }
  const keys = new Set<string>();
  for (const item of document.workflows) {
    const workflow = asRecord(item, "Workflow catalog entry");
    const key = requiredString(workflow.workflow_key, "Workflow key");
    if (!WORKFLOW_KEY_PATTERN.test(key) || keys.has(key)) {
      throw new Error(
        `Workflow catalog contains invalid or duplicate key '${key}'`,
      );
    }
    keys.add(key);
    if (
      workflow.distribution !== "default" &&
      workflow.distribution !== "addon"
    ) {
      throw new Error(`Workflow '${key}' has an invalid distribution`);
    }
    if (workflow.type !== "assistant" && workflow.type !== "tabular") {
      throw new Error(`Workflow '${key}' has an invalid type`);
    }
    requiredString(workflow.title, `Workflow '${key}' title`);
    requiredString(workflow.prompt_md, `Workflow '${key}' prompt`);
    if (
      typeof workflow.content_hash !== "string" ||
      !/^[0-9a-f]{64}$/.test(workflow.content_hash)
    ) {
      throw new Error(`Workflow '${key}' has an invalid content hash`);
    }
    if (!Array.isArray(workflow.assets)) {
      throw new Error(`Workflow '${key}' has invalid assets`);
    }
    if (workflow.assets.length > MAX_ASSETS_PER_WORKFLOW) {
      throw new Error(`Workflow '${key}' exceeds the 50 asset limit`);
    }
    for (const item of workflow.assets) {
      const asset = asRecord(item, `Workflow '${key}' asset`);
      const filename = requiredString(
        asset.filename,
        `Workflow '${key}' asset filename`,
      );
      if (
        filename.startsWith(".") ||
        filename.includes("/") ||
        filename.includes("\\")
      ) {
        throw new Error(`Workflow '${key}' has an unsafe asset filename`);
      }
      requiredString(asset.file_type, `Workflow '${key}' asset file type`);
      if (
        !Number.isInteger(asset.size_bytes) ||
        (asset.size_bytes as number) < 0 ||
        (asset.size_bytes as number) > MAX_FILE_BYTES
      ) {
        throw new Error(`Workflow '${key}' has an invalid asset size`);
      }
      if (
        typeof asset.content_hash !== "string" ||
        !/^[0-9a-f]{64}$/.test(asset.content_hash)
      ) {
        throw new Error(`Workflow '${key}' has an invalid asset hash`);
      }
      requiredString(
        asset.temporary_path,
        `Workflow '${key}' asset temporary path`,
      );
    }
  }
  return value as WorkflowCatalogSourceDocument;
}

export async function prepareWorkflowCatalog(
  options: WorkflowCatalogSourceOptions = {},
): Promise<PreparedWorkflowCatalog> {
  const directory = await mkdtemp(
    path.join(options.temporaryRoot ?? tmpdir(), "mike-workflows-"),
  );
  try {
    const archivePath = path.join(directory, "source.zip");
    const assetDirectory = path.join(directory, "assets");
    await mkdir(assetDirectory, { mode: 0o700 });
    const { repository, ref, commit } =
      await resolveWorkflowSourceCommit(options);
    await downloadArchive(archivePath, repository, commit, options);
    const document = await parseArchive(
      archivePath,
      assetDirectory,
      repository,
      ref,
      commit,
    );
    const catalogPath = path.join(directory, "workflow-catalog.json");
    await writeFile(catalogPath, `${JSON.stringify(document, null, 2)}\n`, {
      mode: 0o600,
    });
    validateWorkflowCatalogDocument(
      JSON.parse(await readFile(catalogPath, "utf8")) as unknown,
    );
    return { directory, catalogPath, archivePath, sourceCommit: commit };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function removePreparedWorkflowCatalog(
  prepared: Pick<PreparedWorkflowCatalog, "directory">,
): Promise<void> {
  await rm(prepared.directory, { recursive: true, force: true });
}
