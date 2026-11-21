/** Keep one cached projection per content event, not every streamed prefix. */
export function createCitationPreprocessor<T>(project: (text: string, citations: T[], targets: T[]) => string) {
    const entries = new Map<number, {text: string; citations: T[]; start: number; result: string; targets: T[]}>();
    return (index: number, text: string, citations: T[], targets: T[]) => {
        const previous = entries.get(index);
        if (previous?.text === text && previous.citations === citations && previous.start === targets.length) {
            targets.push(...previous.targets);
            return previous.result;
        }
        const start = targets.length;
        const result = project(text, citations, targets);
        entries.set(index, {text, citations, start, result, targets: targets.slice(start)});
        return result;
    };
}
