# Shared by scripts/e2e-local-stack.sh and its test. Source it; do not run it.
#
# set_kv rewrites one KEY=value line in an env file (or appends it).
# fill_placeholder_secrets gives a local checkout the throwaway secrets CI
# uses (.github/workflows/e2e.yml) wherever the file still carries the
# template placeholder or no value at all; runtimeConfig.ts refuses the
# placeholders at boot. A real value already in the file is left alone.
#
# Both functions are safe under `set -euo pipefail`: a key that is absent
# from the file is the normal first-run case, not an error.

set_kv() {
    local file=$1 key=$2 value=$3
    if grep -q "^${key}=" "$file" 2>/dev/null; then
        awk -v k="$key" -v v="$value" \
            'index($0, k"=") == 1 { print k "=" v; next } { print }' \
            "$file" >"$file.tmp" && mv "$file.tmp" "$file"
    else
        echo "${key}=${value}" >>"$file"
    fi
}

# Last value of KEY in FILE, or empty when the key is missing. grep exits 1
# on no match; with pipefail that status would otherwise reach the caller's
# `set -e` and abort the script before the fallback is written.
env_value() {
    local file=$1 key=$2
    { grep -E "^${key}=" "$file" 2>/dev/null || true; } | tail -1 | cut -d= -f2-
}

fill_placeholder_secrets() {
    local file=$1
    local pair key rest placeholder local_value current
    for pair in \
        "DOWNLOAD_SIGNING_SECRET=replace-with-a-random-32-byte-hex-string=ci-download-signing-secret-0123456789abcdef" \
        "USER_API_KEYS_ENCRYPTION_SECRET=your-long-random-secret=ci-user-api-keys-encryption-secret-0123456789abcdef"; do
        key=${pair%%=*}; rest=${pair#*=}; placeholder=${rest%%=*}; local_value=${rest#*=}
        current=$(env_value "$file" "$key")
        if [ -z "$current" ] || [ "$current" = "$placeholder" ]; then
            set_kv "$file" "$key" "$local_value"
        fi
    done
}
