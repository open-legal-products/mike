import React, { useCallback, useEffect, useRef } from "react";
import { useWordAssistantChat } from "../../hooks/useWordAssistantChat";
import { useWordTrackedEdits } from "../../hooks/useWordTrackedEdits";
import type { Message as SavedMessage } from "../../types";
import {
  createCloudWordDocumentEdit,
  updateCloudWordChatModel,
  updateCloudWordChatReasoning,
  updateLastSelectedChatModel,
  updateLastSelectedReasoningLevel,
  updateCloudWordDocumentEdit,
} from "../../api/mikeApi";
import {
  createLocalWordDocumentEdit,
  updateLocalWordChatModel,
  updateLocalWordChatReasoning,
  updateLocalWordDocumentEdit,
} from "../../lib/localWordChats";
import type {
  WordChatStorageMode,
  WordEditApplyMode,
} from "../../lib/wordChatSettings";
import { ChatView } from "./ChatView";
import type {
  ReasoningLevel,
  WorkflowAttachment,
} from "../../lib/wordChatTypes";

interface ChatPanelProps {
  sessionKey: number;
  chatId: string | null;
  chatModel: string | null;
  lastSelectedModel: string | null;
  chatReasoningLevel: ReasoningLevel | null;
  lastSelectedReasoningLevel: ReasoningLevel;
  initialMessages: SavedMessage[];
  /**
   * A turn the server is still generating into the opened chat. The pane
   * attaches to it once this session has mounted, so a pane closed mid-answer
   * — or a chat opened from history while its answer runs — shows the answer
   * still streaming instead of a transcript with it missing.
   */
  resumeTurnId?: string | null;
  selectedWorkflow: WorkflowAttachment | null;
  onSelectedWorkflowChange: (workflow: WorkflowAttachment | null) => void;
  onChatIdChange: (chatId: string) => void;
  onChatStarted: () => void;
  onModelSelected: (model: string) => void;
  onReasoningSelected: (level: ReasoningLevel) => void;
  wordDocumentId: string;
  wordChatStorage: WordChatStorageMode;
  wordChatOwnerId: string;
  editApplyMode: WordEditApplyMode;
  onEditApplyModeChange: (mode: WordEditApplyMode) => void;
}

/**
 * Word's equivalent of the frontend assistant page: compose the stateful chat
 * and tracked-edit controllers, then hand both to the view. Office handles,
 * transport code, message rendering, and composer state live below this seam.
 */
export function ChatPanel({
  sessionKey,
  chatId,
  chatModel,
  lastSelectedModel,
  chatReasoningLevel,
  lastSelectedReasoningLevel,
  initialMessages,
  resumeTurnId,
  selectedWorkflow,
  onSelectedWorkflowChange,
  onChatIdChange,
  onChatStarted,
  onModelSelected,
  onReasoningSelected,
  wordDocumentId,
  wordChatStorage,
  wordChatOwnerId,
  editApplyMode,
  onEditApplyModeChange,
}: ChatPanelProps): React.ReactElement {
  const persistWordEdit = useCallback(
    async (
      messageId: string,
      blockIndex: number,
      edit: import("../../lib/redline").RedlineEdit,
      applyMode: WordEditApplyMode,
    ) => {
      if (wordChatStorage === "cloud") {
        return createCloudWordDocumentEdit({
          documentId: wordDocumentId,
          messageId,
          blockIndex,
          originalText: edit.original,
          replacementText: edit.replacement,
          formats: edit.format ?? [],
          occurrence: edit.occurrence,
          reason: edit.reason,
          applyMode,
        });
      }
      return createLocalWordDocumentEdit({
        documentId: wordDocumentId,
        ownerId: wordChatOwnerId,
        messageId,
        blockIndex,
        originalText: edit.original,
        replacementText: edit.replacement,
        formats: edit.format ?? [],
        occurrence: edit.occurrence,
        reason: edit.reason,
        applyMode,
      });
    },
    [wordChatOwnerId, wordChatStorage, wordDocumentId],
  );
  const updateWordEdit = useCallback(
    async (
      messageId: string,
      blockIndex: number,
      patch: import("../../lib/wordChatTypes").PersistedWordEditPatch,
    ): Promise<void> => {
      if (wordChatStorage === "cloud") {
        await updateCloudWordDocumentEdit({
          documentId: wordDocumentId,
          messageId,
          blockIndex,
          patch,
        });
        return;
      }
      await updateLocalWordDocumentEdit({
        documentId: wordDocumentId,
        ownerId: wordChatOwnerId,
        messageId,
        blockIndex,
        patch,
      });
    },
    [wordChatOwnerId, wordChatStorage, wordDocumentId],
  );
  const trackedEdits = useWordTrackedEdits({
    sessionKey,
    initialMessages,
    applyMode: editApplyMode,
    onPersistEdit: persistWordEdit,
    onUpdatePersistedEdit: updateWordEdit,
  });
  const chat = useWordAssistantChat({
    sessionKey,
    chatId,
    initialMessages,
    onChatIdChange,
    onChatStarted,
    wordDocumentId,
    wordChatStorage,
    wordChatOwnerId,
    editApplyMode,
    // Only the identity-stable streaming callbacks; passing the whole
    // controller would tie handleChat's identity to every edit-state change.
    editController: trackedEdits.streamController,
  });

  // Attach once per opened session. `sessionKey` is the conversation
  // boundary the hook itself resets on, so keying the guard to it is what
  // stops a re-render (or a finished turn) from reattaching.
  const resumedSessionRef = useRef<number | null>(null);
  const resumeTurn = chat.resumeTurn;
  useEffect(() => {
    if (!chatId || !resumeTurnId) return;
    if (resumedSessionRef.current === sessionKey) return;
    resumedSessionRef.current = sessionKey;
    // A turn the server has forgotten answers 404; the transcript that has
    // just loaded is then already complete, so there is nothing to report.
    void resumeTurn({ chatId, turnId: resumeTurnId }).catch(() => {});
  }, [chatId, resumeTurn, resumeTurnId, sessionKey]);

  const persistModelSelection = useCallback(
    async (model: string): Promise<void> => {
      if (!chatId) {
        await updateLastSelectedChatModel(model);
      } else if (wordChatStorage === "cloud") {
        await updateCloudWordChatModel(wordDocumentId, chatId, model);
      } else {
        await Promise.all([
          updateLocalWordChatModel({
            documentId: wordDocumentId,
            ownerId: wordChatOwnerId,
            chatId,
            model,
          }),
          updateLastSelectedChatModel(model),
        ]);
      }
      onModelSelected(model);
    },
    [
      chatId,
      onModelSelected,
      wordChatOwnerId,
      wordChatStorage,
      wordDocumentId,
    ],
  );

  const persistReasoningSelection = useCallback(
    async (reasoningLevel: ReasoningLevel): Promise<void> => {
      if (!chatId) {
        await updateLastSelectedReasoningLevel(reasoningLevel);
      } else if (wordChatStorage === "cloud") {
        await updateCloudWordChatReasoning(
          wordDocumentId,
          chatId,
          reasoningLevel,
        );
      } else {
        await Promise.all([
          updateLocalWordChatReasoning({
            documentId: wordDocumentId,
            ownerId: wordChatOwnerId,
            chatId,
            reasoningLevel,
          }),
          updateLastSelectedReasoningLevel(reasoningLevel),
        ]);
      }
      onReasoningSelected(reasoningLevel);
    }, [
      chatId,
      onReasoningSelected,
      wordChatOwnerId,
      wordChatStorage,
      wordDocumentId,
    ],
  );

  return (
    <ChatView
      {...chat}
      {...trackedEdits}
      sessionKey={sessionKey}
      chatModel={chatModel}
      lastSelectedModel={lastSelectedModel}
      chatReasoningLevel={chatReasoningLevel}
      lastSelectedReasoningLevel={lastSelectedReasoningLevel}
      onModelSelected={persistModelSelection}
      onReasoningSelected={persistReasoningSelection}
      selectedWorkflow={selectedWorkflow}
      onSelectedWorkflowChange={onSelectedWorkflowChange}
      editApplyMode={editApplyMode}
      onEditApplyModeChange={onEditApplyModeChange}
    />
  );
}
