import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { authenticatedFetch } from "@/app/lib/authEvents";
import { TextView } from "./TextView";

vi.mock("@/app/lib/mikeApi", () => ({ API_BASE: "/api" }));
vi.mock("@/app/lib/authEvents", () => ({ authenticatedFetch: vi.fn() }));
vi.mock("@/app/lib/userFacingError", () => ({
  describeError: () => ({ message: "Could not load document." }),
  notifyError: vi.fn(),
}));
beforeEach(() => vi.clearAllMocks());

describe("TextView", () => {
  it("renders Unicode Markdown as text and highlights a cited quotation", async () => {
    vi.mocked(authenticatedFetch).mockResolvedValue(new Response("# Başlık\nhello world\nTürkçe metin", {
      headers: { "Content-Type": "text/markdown; charset=utf-8" },
    }));
    render(<TextView doc={{ document_id: "doc", version_id: "v1" }} quotes={[{ quote: "hello world" }]} />);
    await waitFor(() => expect(screen.getByText(/Türkçe metin/)).toBeTruthy());
    await waitFor(() => expect(document.querySelector(".pdf-text-highlight")?.textContent).toBe("hello world"));
    expect(authenticatedFetch).toHaveBeenCalledWith("/api/single-documents/doc/display?version_id=v1",
      expect.objectContaining({ credentials: "include" }));
  });
  it("shows a retry affordance on an invalid response", async () => {
    vi.mocked(authenticatedFetch).mockResolvedValue(new Response("Not found", { status: 404 }));
    render(<TextView doc={{ document_id: "doc" }} />);
    expect(await screen.findByRole("button", { name: "Retry" })).toBeTruthy();
  });
});

it("fetches updated bytes when refetchKey changes at an unchanged URL", async () => {
  vi.mocked(authenticatedFetch)
    .mockResolvedValueOnce(new Response("Original", { headers: { "Content-Type": "text/plain" } }))
    .mockResolvedValueOnce(new Response("Revised", { headers: { "Content-Type": "text/plain" } }));
  const { rerender } = render(<TextView doc={{ document_id: "doc" }} refetchKey="before" />);
  await waitFor(() => expect(screen.getByText("Original")).toBeTruthy());
  rerender(<TextView doc={{ document_id: "doc" }} refetchKey="after" />);
  await waitFor(() => expect(screen.getByText("Revised")).toBeTruthy());
  expect(authenticatedFetch).toHaveBeenCalledTimes(2);
});
