import { afterEach, describe, expect, it, vi } from "vitest";
import { isOutlookHost, officeHostKind } from "../../../word-addin/src/taskpane/lib/officeHost";
import {
  currentOutlookSubject,
  draftToHtml,
  getOrCreateOutlookDocumentId,
  insertIntoEmail,
  mimeTypeForName,
  readComposeAttachmentFiles,
  readComposeMarkdown,
} from "../../../word-addin/src/taskpane/lib/outlookCompose";

describe("Outlook compose host adapter", () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).Office;
  });

  it("defaults to the Word host when Office is absent or incomplete and detects Outlook when Mailbox is active", () => {
    delete (globalThis as Record<string, unknown>).Office;
    expect(officeHostKind()).toBe("word");
    expect(isOutlookHost()).toBe(false);

    (globalThis as Record<string, unknown>).Office = {
      HostType: { Outlook: "Outlook", Word: "Word" },
      context: { host: "Outlook", mailbox: { item: {} } },
    };
    expect(officeHostKind()).toBe("outlook");
    expect(isOutlookHost()).toBe(true);
  });

  it("fails closed without network or state mutations when the compose item is missing", async () => {
    delete (globalThis as Record<string, unknown>).Office;
    await expect(getOrCreateOutlookDocumentId()).rejects.toThrow("No message is open for writing");
    await expect(readComposeMarkdown()).rejects.toThrow("No message is open for writing");
    await expect(readComposeAttachmentFiles()).rejects.toThrow("No message is open for writing");
    await expect(insertIntoEmail("Draft", "top")).rejects.toThrow("No message is open for writing");
    expect(currentOutlookSubject()).toBe("Email");
  });

  it("reads the compose form locally, caps long bodies, and skips oversized or non-file attachments before decoding", async () => {
    const getAttachmentContentAsync = vi.fn((id: string, cb: (res: unknown) => void) => {
      cb({
        status: "succeeded",
        value: {
          format: "base64",
          content: Buffer.from(`bytes-${id}`).toString("base64"),
        },
      });
    });

    (globalThis as Record<string, unknown>).Office = {
      AsyncResultStatus: { Succeeded: "succeeded" },
      CoercionType: { Text: "text", Html: "html" },
      MailboxEnums: {
        AttachmentType: { File: "file", Item: "item", Cloud: "cloud" },
        AttachmentContentFormat: { Base64: "base64", Url: "url" },
      },
      context: {
        mailbox: {
          item: {
            subject: { getAsync: (cb: (r: unknown) => void) => cb({ status: "succeeded", value: "Arbitration Notice" }) },
            to: {
              getAsync: (cb: (r: unknown) => void) =>
                cb({ status: "succeeded", value: [{ displayName: "Counsel", emailAddress: "counsel@example.com" }] }),
            },
            cc: { getAsync: (cb: (r: unknown) => void) => cb({ status: "succeeded", value: [] }) },
            body: {
              getAsync: (_t: unknown, cb: (r: unknown) => void) =>
                cb({ status: "succeeded", value: "A".repeat(200_050) }),
              getTypeAsync: (cb: (r: unknown) => void) => cb({ status: "succeeded", value: "html" }),
              prependAsync: (_d: unknown, _o: unknown, cb: (r: unknown) => void) => cb({ status: "succeeded" }),
              setSelectedDataAsync: (_d: unknown, _o: unknown, cb: (r: unknown) => void) => cb({ status: "succeeded" }),
            },
            getAttachmentsAsync: (cb: (r: unknown) => void) =>
              cb({
                status: "succeeded",
                value: [
                  { id: "a1", name: "claim.pdf", attachmentType: "file", size: 120, isInline: false },
                  { id: "a2", name: "huge.pdf", attachmentType: "file", size: 60 * 1024 * 1024, isInline: false },
                  { id: "a3", name: "cloud-link.docx", attachmentType: "cloud", size: 100, isInline: false },
                ],
              }),
            getAttachmentContentAsync,
          },
        },
      },
    };

    const markdown = await readComposeMarkdown();
    expect(markdown).toContain("Subject: Arbitration Notice");
    expect(markdown).toContain("Counsel <counsel@example.com>");
    expect(markdown).toContain("[Body truncated: 50 more characters not shown]");
    expect(currentOutlookSubject()).toBe("Arbitration Notice");

    const { files, skipped } = await readComposeAttachmentFiles();
    expect(files.map((f) => f.name)).toEqual(["claim.pdf"]);
    expect(files[0]!.type).toBe("application/pdf");
    expect(skipped).toEqual(["huge.pdf", "cloud-link.docx"]);
    expect(getAttachmentContentAsync).toHaveBeenCalledTimes(1);
  });

  it("rejects attachment reads if the attachment list changes while content is being fetched", async () => {
    let callCount = 0;
    (globalThis as Record<string, unknown>).Office = {
      AsyncResultStatus: { Succeeded: "succeeded" },
      MailboxEnums: {
        AttachmentType: { File: "file", Item: "item", Cloud: "cloud" },
        AttachmentContentFormat: { Base64: "base64", Url: "url" },
      },
      context: {
        mailbox: {
          item: {
            getAttachmentsAsync: (cb: (r: unknown) => void) => {
              callCount += 1;
              cb({
                status: "succeeded",
                value:
                  callCount === 1
                    ? [{ id: "0", name: "first.pdf", attachmentType: "file", size: 120, isInline: false }]
                    : [{ id: "0", name: "second.pdf", attachmentType: "file", size: 240, isInline: false }],
              });
            },
            getAttachmentContentAsync: (_id: string, cb: (r: unknown) => void) =>
              cb({
                status: "succeeded",
                value: { format: "base64", content: Buffer.from("pdf").toString("base64") },
              }),
          },
        },
      },
    };

    await expect(readComposeAttachmentFiles()).rejects.toThrow(
      "The message attachments changed while they were being read",
    );
  });

  it("returns an existing draft UUID without saving, creates and saves when absent, and rejects when saving fails", async () => {
    let storedId: string | undefined = "existing-uuid-1234";
    let saveHandler: (cb: (r: unknown) => void) => void = (cb) => cb({ status: "succeeded" });
    const set = vi.fn();
    const saveAsync = vi.fn((cb: (r: unknown) => void) => saveHandler(cb));

    (globalThis as Record<string, unknown>).Office = {
      AsyncResultStatus: { Succeeded: "succeeded" },
      context: {
        mailbox: {
          item: {
            subject: { getAsync: (cb: (r: unknown) => void) => cb({ status: "succeeded", value: "Draft Subject" }) },
            loadCustomPropertiesAsync: (cb: (r: unknown) => void) =>
              cb({
                status: "succeeded",
                value: {
                  get: () => storedId,
                  set,
                  saveAsync,
                },
              }),
          },
        },
      },
    };

    await expect(getOrCreateOutlookDocumentId()).resolves.toBe("existing-uuid-1234");
    expect(set).not.toHaveBeenCalled();
    expect(saveAsync).not.toHaveBeenCalled();

    storedId = undefined;
    let triggerSave!: (r: unknown) => void;
    saveHandler = (cb) => {
      triggerSave = cb;
    };

    let settled = false;
    const creating = getOrCreateOutlookDocumentId().then((v) => {
      settled = true;
      return v;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    triggerSave({ status: "succeeded" });
    const createdId = await creating;
    expect(typeof createdId).toBe("string");
    expect(createdId.length).toBeGreaterThan(10);
    expect(set.mock.calls[0]).toEqual(["mike.outlook.documentId.v1", createdId]);

    saveHandler = (cb) => cb({ status: "failed", error: { message: "Save failed" } });
    await expect(getOrCreateOutlookDocumentId()).rejects.toThrow("Save failed");
  });

  it("escapes HTML entities and quotes in draftToHtml and maps attachment MIME types", () => {
    expect(draftToHtml('Hello "world" & <script>\nLine 2\n\nSecond para')).toBe(
      "<p>Hello &quot;world&quot; &amp; &lt;script&gt;<br>Line 2</p><p>Second para</p>",
    );
    expect(mimeTypeForName("contract.docx")).toContain("wordprocessingml");
    expect(mimeTypeForName("scan.png")).toBe("image/png");
    expect(mimeTypeForName("unknown.bin")).toBe("application/octet-stream");
  });
});
