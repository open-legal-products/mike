export function AuthDividerUI() {
    return (
        <div className="flex items-center gap-3 py-1" aria-hidden="true">
            <div className="h-px flex-1 bg-gray-200" />
            <span className="text-xs text-gray-400">or</span>
            <div className="h-px flex-1 bg-gray-200" />
        </div>
    );
}
