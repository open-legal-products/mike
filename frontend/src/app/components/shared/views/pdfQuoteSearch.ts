export const normalizePdfQuoteText = (text: string) => text.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
export const pdfQuoteKeys = (quote: string) => quote.split(/\.{3}|…/).map(normalizePdfQuoteText).filter(Boolean).map(part => part.slice(0, 30));

/** Match a batch of quote prefixes in one pass over each page (Aho–Corasick). */
export function createPdfQuoteMatcher(quotes: readonly string[]) {
    type Node = { next: Map<string, number>; fail: number; results: number[] };
    const nodes: Node[] = [{next:new Map(),fail:0,results:[]}];
    quotes.forEach((quote, index) => {
        for (const pattern of pdfQuoteKeys(quote)) {
            let state = 0;
            for (const char of pattern) {
                let next = nodes[state].next.get(char);
                if (next === undefined) {
                    next = nodes.length;
                    nodes.push({next:new Map(),fail:0,results:[]});
                    nodes[state].next.set(char, next);
                }
                state = next;
            }
            nodes[state].results.push(index);
        }
    });
    const queue = [...nodes[0].next.values()];
    for (let position = 0; position < queue.length; position++) {
        const state = queue[position];
        for (const [char, next] of nodes[state].next) {
            let fallback = nodes[state].fail;
            while (fallback && !nodes[fallback].next.has(char)) fallback = nodes[fallback].fail;
            nodes[next].fail = nodes[fallback].next.get(char) ?? 0;
            queue.push(next);
        }
    }
    const pages = new Map<number, number>();
    return {
        pages,
        scan(text: string, page: number) {
            let state = 0;
            for (const char of text) {
                while (state && !nodes[state].next.has(char)) state = nodes[state].fail;
                state = nodes[state].next.get(char) ?? 0;
                // Keys have at most 30 characters, bounding the suffix walk.
                for (let suffix = state; suffix; suffix = nodes[suffix].fail) {
                    for (const index of nodes[suffix].results) if (!pages.has(index)) pages.set(index, page);
                    nodes[suffix].results = []; // First page only; never revisit result fan-out.
                }
            }
        },
    };
}
