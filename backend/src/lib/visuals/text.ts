import { convert } from "html-to-text";
import { parseStoredVisual } from "./source";

export async function visualVisibleText(stored: Buffer | ArrayBuffer): Promise<string> {
  const { title, html } = await parseStoredVisual(stored);
  const body = convert(html, {
    wordwrap: false,
    selectors: [
      { selector: "script", format: "skip" },
      { selector: "style", format: "skip" },
      { selector: "a", options: { ignoreHref: true } },
      { selector: "img", format: "skip" },
      ...["h1", "h2", "h3", "h4"].map((selector) => ({ selector, options: { uppercase: false } })),
    ],
  }).trim();
  return body ? `${title}\n\n${body}` : title;
}
