import type { PlaybookContent } from "@/app/lib/mikeApi";

export type RuleDropTarget = {
  topicId: string | null;
  ruleId?: string;
  position?: "before" | "after";
};

/** Reorder in place or move between groups without changing rule IDs/content. */
export function movePlaybookRule(
  content: PlaybookContent,
  ruleId: string,
  target: RuleDropTarget,
): PlaybookContent {
  const rootRules = content.rules ?? [];
  const rule = [
    ...rootRules,
    ...content.topics.flatMap((topic) => topic.rules),
  ].find((entry) => entry.id === ruleId);
  const destination =
    target.topicId === null
      ? rootRules
      : content.topics.find((topic) => topic.id === target.topicId)?.rules;
  if (!rule || !destination || target.ruleId === ruleId) return content;
  if (target.ruleId && !destination.some((entry) => entry.id === target.ruleId))
    return content;
  const next = destination.filter((entry) => entry.id !== ruleId);
  const index = target.ruleId
    ? next.findIndex((entry) => entry.id === target.ruleId) +
      (target.position === "after" ? 1 : 0)
    : next.length;
  next.splice(index, 0, rule);
  if (
    next.length === destination.length &&
    next.every((entry, i) => entry === destination[i])
  )
    return content;
  return {
    ...content,
    rules:
      target.topicId === null
        ? next
        : rootRules.filter((entry) => entry.id !== ruleId),
    topics: content.topics.map((topic) => ({
      ...topic,
      rules:
        topic.id === target.topicId
          ? next
          : topic.rules.filter((entry) => entry.id !== ruleId),
    })),
  };
}
