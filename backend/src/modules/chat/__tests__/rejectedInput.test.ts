import { expect, it } from "vitest";
import { scriptedDb } from "../../../__tests__/helpers/scriptedDb";
import { discardRejectedChatInput } from "../chat.service";
it("removes only the raced request's input, never another writer's message", async () => {
  const fake = scriptedDb([{ table: "chat_messages", op: "delete" }]);
  expect(await discardRejectedChatInput(fake.db, { chatId: "chat", inputMessageId: "rejected", userId: "actor" })).toEqual({ ok: true });
  expect(fake.calls[0].filters).toEqual([
    ["eq", "id", "rejected"], ["eq", "chat_id", "chat"],
    ["eq", "role", "user"], ["eq", "author_user_id", "actor"],
  ]);
  fake.done();
});
