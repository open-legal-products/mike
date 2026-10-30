/** Drain a large backlog geometrically, preserving the old small-chunk speed. */
export function nextRevealLength(displayed: number, target: number): number {
    return Math.min(target, displayed + Math.max(8, Math.ceil((target - displayed) / 25)));
}
