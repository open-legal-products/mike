import { DropdownItem } from "@mike/ui";
import { versionLabel, type VersionComparison } from "./versionComparison";

export function ComparisonMenuItems({ pairs, onCompare }: {
    pairs: VersionComparison[];
    onCompare: (pair: VersionComparison) => void;
}) {
    return pairs.map((pair) => (
        <DropdownItem key={pair.base.id} onSelect={() => onCompare(pair)}>
            <span>
                Compare with {versionLabel(pair.base)}
                {pair.base.version_number == null && (
                    <span className="block text-xs">{pair.base.filename} · {new Date(pair.base.created_at).toLocaleTimeString()}</span>
                )}
            </span>
        </DropdownItem>
    ));
}
