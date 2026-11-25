/**
 * Inline citations when the model writes them imperfectly: a tag that is
 * never closed, a `[[` that is not a tag, the same passage cited twice, and
 * a tag naming a passage that does not exist. In each case the reader must
 * see the prose the model wrote, never raw tag syntax, and the stream must
 * not hold text back for longer than a tag can be.
 */
import { describe, expect, it } from "vitest";
import { createInlineCitationStream, type InlineSource } from "./inlineCitations";

function streamed(
  chunks: string[],
  exists?: (source: InlineSource) => boolean | undefined,
) {
  const stream = createInlineCitationStream({ maxCitations: 50, exists });
  const pushed = chunks.map((c) => stream.push(c));
  const out = pushed.join("") + stream.flush();
  return { out, pushed, stream };
}

/** Every split of `text` into deltas of `size` characters. */
const deltas = (text: string, size: number) => {
  const parts: string[] = [];
  for (let i = 0; i < text.length; i += size) parts.push(text.slice(i, i + size));
  return parts;
};

describe("a tag the model never closes", () => {
  it("keeps the prose after it and still cites, when a later tag closes", () => {
    const text = "Notice is nine months [[doc-0 34. The rent is £186,000 [[doc-0 10]].";
    for (const size of [1, 3, 7, 200]) {
      expect(streamed(deltas(text, size)).out).toBe(
        "Notice is nine months [1]. The rent is £186,000 [2].",
      );
    }
  });

  it("does not hold the answer back waiting for a ]] that never comes", () => {
    // Words after passage numbers may be a sheet name ("2025 Budget!B7"),
    // so the stream waits up to 40 characters for a "!", then releases.
    const prose = " and the rent is high, payable quarterly in advance on the usual quarter days";
    const { pushed } = streamed([`Notice is nine months [[doc-0 34${prose}`]);
    expect(pushed[0]).toBe(`Notice is nine months [1]${prose}`);
    expect(streamed(["Notice [[doc-0 34 and rent"]).out).toBe("Notice [1] and rent");
  });

  it("reads a sheet name that starts with a number as a cell, not as prose after a passage", () => {
    expect(streamed(["Budget [[doc-2 2025 Budget!B7]]."]).stream.entries()).toEqual([
      { ref: 1, source: { kind: "cell", doc: "doc-2", sheet: "2025 Budget", cell: "B7" } },
    ]);
  });

  it("rescans when removing a stray ]] joins a new [[", () => {
    const text = "A [[doc-0 1 junk[]][doc-0 2]] B";
    const whole = streamed([text]).out;
    expect(whole).not.toMatch(/\[\[\s*doc-/);
    for (const size of [1, 3, 17]) expect(streamed(deltas(text, size)).out).toBe(whole);
  });

  it("ends a tag at a line break", () => {
    expect(streamed(["Notice [[doc-0 34\nNext paragraph."]).out).toBe(
      "Notice [1]\nNext paragraph.",
    );
  });

  it("accepts a tag closed with a single bracket", () => {
    expect(streamed(["Notice [[doc-0 34]. Rent [[doc-0 10]]."]).out).toBe(
      "Notice [1]. Rent [2].",
    );
  });

  it("keeps a quoted tag whose closing brackets are missing", () => {
    expect(streamed(['Notice [[doc-0 34 "nine months" applies.']).out).toBe(
      "Notice [1] applies.",
    );
  });

  it("drops the tag head but keeps the words when a quote is never closed", () => {
    const { out } = streamed(['Notice [[doc-0 "nine months written notice\n\nNext paragraph.']);
    expect(out).not.toContain("[[");
    expect(out).toContain("Next paragraph.");
  });

  it("cites from an unfinished tag at the end of the answer", () => {
    expect(streamed(["Notice is nine months [[doc-0 34"]).out).toBe(
      "Notice is nine months [1]",
    );
  });
});

describe("a closed tag that is not a citation", () => {
  it("is dropped with everything inside it: what the model put in a tag is never prose", () => {
    const { out, stream } = streamed(['A [[doc-0 the notice clause]]. B [[doc-0 "no closing quote ]]. C [[doc-0 12]].']);
    expect(out).toBe("A. B. C [1].");
    expect(stream.malformedCount()).toBe(2);
  });

  it("drops words inside a tag that closes soon after its passage numbers", () => {
    for (const size of [1, 2, 5, 100]) {
      expect(streamed(deltas("C [[doc-0 34 junk]]. Next [[doc-0 10]].", size)).out).toBe(
        "C [1]. Next [2].",
      );
    }
  });

  it("removes the stray ]] after prose that outran the wait", () => {
    const prose = " and the deposit is held in a separate designated account";
    expect(streamed([`C [[doc-0 34${prose}]]. Next [[doc-0 10]].`]).out).toBe(`C [1]${prose}. Next [2].`);
  });
});

describe("double brackets that are not a tag", () => {
  it("are released at once, not held for hundreds of characters", () => {
    const { pushed } = streamed(["See [[Clause 4 of the lease and the schedule"]);
    expect(pushed[0]).toBe("See [[Clause 4 of the lease and the schedule");
  });
});

describe("the same passage cited twice", () => {
  it("gets one number whether or not a quote narrows it", () => {
    expect(
      streamed(['A [[doc-0 34]]. B [[doc-0 34 "nine months"]]. C [[doc-0 10]].']).out,
    ).toBe("A [1]. B [1]. C [2].");
  });
});

describe("a tag that gets no marker", () => {
  it("does not leave a space before the punctuation that follows it", () => {
    const missing = (s: InlineSource) =>
      s.kind === "passages" && s.ranges[0][0] === 999 ? false : undefined;
    expect(streamed(["The term is ten years [[doc-0 999]]. Rent [[doc-0 10]]."], missing).out).toBe(
      "The term is ten years. Rent [1].",
    );
  });
});

describe("any answer, split anywhere", () => {
  // A small seeded generator, so a failure reproduces.
  function rng(seed: number) {
    return () => {
      seed = (seed * 1664525 + 1013904223) % 2 ** 32;
      return seed / 2 ** 32;
    };
  }
  const WORDS = ["The", "tenant", "must", "give", "notice", "of", "nine", "months", "rent", "is", "£186,000", "under", "clause", "10.1"];
  const VALID = [
    "[[doc-0 34]]", "[[doc-0 3-4]]", '[[doc-0 7 "nine months"]]', '[[doc-0 "exact words"]]',
    "[[doc-2 Rent schedule!D4]]", "[[doc-0 12; doc-1 4]]",
  ];
  const BROKEN = ["[[doc-0 34", "[[doc-0 34]", '[[doc-0 "unclosed quote', "[[doc-0 x!]]", "[[case-9", "[[doc-0 give"];
  const NOT_TAGS = ["[[PAGE_BREAK]]", "[[Clause 4]]", "["];
  const SEEDS = Number(process.env.CITATION_FUZZ_SEEDS ?? 300);

  function answer(seed: number, tags: string[]) {
    const random = rng(seed);
    const parts: string[] = [];
    const words: string[] = [];
    for (let n = 0; n < 40; n++) {
      if (random() < 0.25) parts.push(` ${tags[Math.floor(random() * tags.length)]}`);
      else {
        const word = WORDS[Math.floor(random() * WORDS.length)];
        words.push(word);
        parts.push(` ${word}${random() < 0.1 ? "." : ""}${random() < 0.05 ? "\n" : ""}`);
      }
    }
    const text = parts.join("");
    const chunks: string[] = [];
    for (let i = 0; i < text.length; ) {
      const size = 1 + Math.floor(random() * 12);
      chunks.push(text.slice(i, i + size));
      i += size;
    }
    return { text, chunks, words };
  }

  it("never shows tag syntax and does not depend on how deltas split, even with stray brackets", () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const { text, chunks } = answer(seed, [...VALID, ...BROKEN, ...NOT_TAGS, "]]"]);
      const whole = streamed([text]).out;
      expect(streamed(chunks).out, `seed ${seed}`).toBe(whole);
      expect(whole, `seed ${seed}`).not.toMatch(/\[\[\s*(?:doc|case)-/);
    }
  });

  it("keeps every word written outside a tag", () => {
    // Without stray "]]", every word below is outside any closed tag. (Text
    // inside a closed tag is citation syntax and is never shown as prose.)
    for (let seed = 1; seed <= SEEDS; seed++) {
      const { chunks, words } = answer(seed, [...VALID, ...BROKEN, ...NOT_TAGS]);
      const out = streamed(chunks).out;
      let at = 0;
      for (const word of words) {
        const found = out.indexOf(word, at);
        expect(found, `seed ${seed}: "${word}" lost from ${JSON.stringify(out)}`).toBeGreaterThanOrEqual(0);
        at = found + word.length;
      }
    }
  });
});

describe("evidence written inside a tag instead of the sentence", () => {
  it("shows the quoted words when the sentence is unfinished without them", () => {
    const { out, stream } = streamed([
      'The landlord is [[COL:0 ROW:0 "Harbourside Properties Limited"]], and the tenant must give [[doc-0 34 "nine months\' written notice"]].',
    ]);
    expect(out).toBe(
      "The landlord is Harbourside Properties Limited [1], and the tenant must give nine months' written notice [2].",
    );
    expect(stream.quoteAsTextCount()).toBe(2);
  });

  it("leaves a quote alone when the sentence already says it or is complete", () => {
    const { out, stream } = streamed([
      'The tenant must give nine months\' written notice [[doc-0 34 "nine months"]]. Rent is reviewed in 2030 [[doc-0 15 "1 April 2030"]].',
    ]);
    expect(out).toBe("The tenant must give nine months' written notice [1]. Rent is reviewed in 2030 [2].");
    expect(stream.quoteAsTextCount()).toBe(0);
  });
});
