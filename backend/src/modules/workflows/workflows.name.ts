const WORKFLOW_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function parseScalar(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed);
      return typeof parsed === "string" ? parsed : null;
    } catch {
      return null;
    }
  }

  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

export function normalizeWorkflowName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return WORKFLOW_NAME_PATTERN.test(trimmed) ? trimmed : null;
}

export function workflowNameFromSkillMd(skillMd: unknown): string | null {
  if (typeof skillMd !== "string") return null;

  const frontmatter = skillMd.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!frontmatter) return null;

  for (const line of frontmatter[1].split(/\r?\n/)) {
    const match = line.match(/^name:\s*(.*?)\s*$/);
    if (!match) continue;
    return normalizeWorkflowName(parseScalar(match[1]));
  }

  return null;
}
