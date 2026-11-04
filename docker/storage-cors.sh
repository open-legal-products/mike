#!/bin/sh
# Print the object-storage bucket CORS policy for this deployment on stdout.
#
# Browsers PUT uploads straight to the signed storage URL, so the bucket must
# allow each origin the app is opened from. The origins come from the same
# variables the backend uses for its own CORS (backend/src/lib/origins.ts):
#
#   FRONTEND_URL    the web app (default http://localhost:3000)
#   WORD_ADDIN_URL  the Word add-in (default https://localhost:3200)
#
# Only the scheme://host[:port] part is used; a path or trailing slash is
# dropped. The createbucket service in docker-compose.yml and the e2e CI job
# both install this output, so they cannot drift apart.
#
#   FRONTEND_URL=https://mike.example sh docker/storage-cors.sh > cors.json
#
# POSIX sh only: it runs inside the amazon/aws-cli image.
set -eu

origin() {
    url=$1
    scheme=${url%%://*}
    rest=${url#*://}
    host=${rest%%/*}
    host=${host%%\?*}
    host=${host%%#*}
    if [ "$scheme" = "$url" ] || [ -z "$host" ]; then
        echo "storage-cors: not an absolute URL: $url" >&2
        exit 1
    fi
    case "$scheme" in
        http|https) ;;
        *) echo "storage-cors: not an http(s) URL: $url" >&2; exit 1 ;;
    esac
    # A host is letters, digits, dots, hyphens, a port, or an [IPv6]
    # literal; anything else (a quote, a space) would corrupt the JSON.
    case "$host" in
        *[!A-Za-z0-9.:\[\]-]*) echo "storage-cors: invalid host in URL: $url" >&2; exit 1 ;;
    esac
    printf '%s://%s' "$scheme" "$host"
}

frontend=$(origin "${FRONTEND_URL:-http://localhost:3000}")
addin=$(origin "${WORD_ADDIN_URL:-https://localhost:3200}")
if [ "$addin" = "$frontend" ]; then
    origins="\"$frontend\""
else
    origins="\"$frontend\", \"$addin\""
fi

cat <<EOF
{
  "CORSRules": [
    {
      "AllowedOrigins": [$origins],
      "AllowedMethods": ["PUT", "HEAD"],
      "AllowedHeaders": ["Content-Type", "x-amz-*"],
      "ExposeHeaders": ["ETag"],
      "MaxAgeSeconds": 3600
    }
  ]
}
EOF
