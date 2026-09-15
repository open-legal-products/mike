import { type Response } from "express";

export function openAssistantSse(res: Response): {
  signal: AbortSignal;
  write: (line: string) => boolean;
  finish: () => void;
} {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const controller = new AbortController();
  let finished = false;
  res.on("close", () => {
    if (!finished) controller.abort();
  });

  return {
    signal: controller.signal,
    // A producer can lose the race against finish(): an error handler that
    // fires after the happy path already ended the response would call
    // res.write() on an ended stream, raising an asynchronous
    // ERR_STREAM_WRITE_AFTER_END that no try/catch around the write can see.
    // Dropping the late line is correct — the response is over either way.
    write: (line) => {
      if (finished || res.writableEnded) return false;
      return res.write(line);
    },
    finish: () => {
      if (finished) return;
      finished = true;
      res.end();
    },
  };
}
