"use client";

import {
  MarkdownEditor,
  type MarkdownEditorProps,
} from "@/app/components/ui/markdown-editor";
import { cn } from "@/app/lib/utils";

export function WorkflowPromptEditor({
  className,
  ...props
}: MarkdownEditorProps) {
  return (
    <MarkdownEditor
      {...props}
      ariaLabel={props.ariaLabel ?? "Workflow prompt"}
      className={cn("workflow-prompt-editor-surface", className)}
    />
  );
}
