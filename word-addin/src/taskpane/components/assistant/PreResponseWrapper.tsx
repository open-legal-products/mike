import React from "react";
import { PreResponseWrapperUI } from "@mike/ui";

/**
 * Maps the Word pane's activity state into the shared pre-response UI.
 */
export function PreResponseWrapper({
  children,
  stepCount,
  shouldMinimize,
  isStreaming,
}: {
  children: React.ReactNode;
  stepCount: number;
  shouldMinimize: boolean;
  isStreaming: boolean;
}): React.ReactElement {
  return (
    <PreResponseWrapperUI
      stepCount={stepCount}
      shouldMinimize={shouldMinimize}
      isStreaming={isStreaming}
    >
      {children}
    </PreResponseWrapperUI>
  );
}
