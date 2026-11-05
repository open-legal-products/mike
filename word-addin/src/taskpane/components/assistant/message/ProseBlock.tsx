import React from "react";
import { EXCERPT_SOURCE_PROPS } from "@mike/response-selection-menu-ui";
import { Markdown } from "../../../../shared/chat/Markdown";
import { projectCitationMarkdown } from "../../../lib/citations";
import { useMarkdownCheckpoint } from "../../../lib/markdownCheckpoint";
import type { WordAssistantMessage } from "../../../lib/wordChatTypes";

export const ProseBlock = React.memo(function ProseBlock({ text, citations, onClick, isStreaming }: {
  text: string;
  citations: WordAssistantMessage["citations"];
  onClick: React.MouseEventHandler<HTMLDivElement>;
  isStreaming: boolean;
}) {
  const { richText, plainTail } = useMarkdownCheckpoint(text, isStreaming);
  const markdown = React.useMemo(() => projectCitationMarkdown(richText, citations), [richText, citations]);
  return <div {...EXCERPT_SOURCE_PROPS} className="font-serif text-base leading-7 text-gray-900" onClick={onClick}>
    <Markdown className="text-base leading-7">{markdown}</Markdown>
    {plainTail && <span className="whitespace-pre-wrap break-words">{plainTail}</span>}
  </div>;
});
