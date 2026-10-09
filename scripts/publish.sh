#!/usr/bin/env bash
set -euo pipefail
# Usage: ARTIFACT_SHARE_URL=https://intranet/artifacts ARTIFACT_SHARE_KEY=ash_... ./scripts/publish.sh report.md 'Report' [link|users] [user-id,...]
: "${ARTIFACT_SHARE_URL:?Set ARTIFACT_SHARE_URL including the base path}"
: "${ARTIFACT_SHARE_KEY:?Set ARTIFACT_SHARE_KEY}"
file=${1:?Specify an HTML or Markdown file}
title=${2:-$(basename "$file")}
visibility=${3:-link}
recipients=${4:-}
case "$file" in *.html|*.htm) kind=html;; *.md|*.markdown) kind=md;; *) echo 'Expected .html, .htm, .md or .markdown' >&2; exit 1;; esac
jq -n --rawfile content "$file" --arg title "$title" --arg kind "$kind" --arg visibility "$visibility" --arg recipients "$recipients" \
 '{title:$title,kind:$kind,content:$content,visibility:$visibility,users:($recipients|split(",")|map(select(length>0)))}' |
 curl --fail-with-body --silent --show-error "${ARTIFACT_SHARE_URL%/}/api/artifacts" \
 -H "Authorization: Bearer $ARTIFACT_SHARE_KEY" -H 'Content-Type: application/json' --data-binary @-
