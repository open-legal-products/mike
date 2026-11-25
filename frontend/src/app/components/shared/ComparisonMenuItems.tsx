import { DropdownItem } from "@mike/ui";
import { COMPARISON_SIZE_MESSAGE, exceedsComparisonLimit, versionLabel, type VersionComparison } from "./versionComparison";

export function ComparisonMenuItems({ pairs, onCompare }: {
    pairs: VersionComparison[];
    onCompare: (pair: VersionComparison) => void;
}) {
    return pairs.map((pair) => {
        const tooLarge = exceedsComparisonLimit(pair);
        return (
            <DropdownItem key={pair.base.id} disabled={tooLarge} onSelect={() => onCompare(pair)}>
                <span>
                    Compare with {versionLabel(pair.base)}
                    {pair.base.version_number == null && (
                        <span className="block text-xs">{pair.base.filename} · {new Date(pair.base.created_at).toLocaleTimeString()}</span>
                    )}
                    {tooLarge && <span className="block text-xs">{COMPARISON_SIZE_MESSAGE}</span>}
                </span>
            </DropdownItem>
        );
    });
}
