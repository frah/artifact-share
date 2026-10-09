#!/usr/bin/env bash
set -euo pipefail
# Usage: ARTIFACT_SHARE_URL=https://intranet/artifacts ARTIFACT_SHARE_KEY=ash_... ./scripts/publish.sh report.md 'Report' [link|users] [user-id,...] [source-path]
: "${ARTIFACT_SHARE_URL:?Set ARTIFACT_SHARE_URL including the base path}"
: "${ARTIFACT_SHARE_KEY:?Set ARTIFACT_SHARE_KEY}"
file=${1:?Specify an HTML or Markdown file}
title=${2:-$(basename "$file")}
visibility=${3:-link}
recipients=${4:-}
if [ "$#" -ge 5 ]; then
 source_path=$5
else
 source_path=$file
 case "$source_path" in /*|[A-Za-z]:*|..|../*|*/../*) source_path=$(basename "$file");; esac
 source_path=${source_path#./}
fi
case "$file" in *.html|*.htm) kind=html;; *.md|*.markdown) kind=md;; *) echo 'Expected .html, .htm, .md or .markdown' >&2; exit 1;; esac
jq -n --rawfile content "$file" --arg title "$title" --arg kind "$kind" --arg visibility "$visibility" --arg recipients "$recipients" --arg source_path "$source_path" \
 '{title:$title,kind:$kind,content:$content,source_path:$source_path,visibility:$visibility,users:($recipients|split(",")|map(select(length>0)))}' |
 curl --fail-with-body --silent --show-error "${ARTIFACT_SHARE_URL%/}/api/artifacts" \
 -H "Authorization: Bearer $ARTIFACT_SHARE_KEY" -H 'Content-Type: application/json' --data-binary @-
