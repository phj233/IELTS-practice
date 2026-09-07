#!/bin/sh
# Synchronize only generated question-bank assets from a Git remote.
# This script is intended for a dedicated deployment checkout. It never pulls
# application code, changes Docker containers, or touches PostgreSQL data.

set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/../.." && pwd)
remote=${QUESTION_BANK_REMOTE:-origin}
branch=${QUESTION_BANK_BRANCH:-main}
interval=${QUESTION_BANK_CHECK_INTERVAL_SECONDS:-900}
version_file=assets/generated/question-bank-version.json
asset_paths='assets/generated/reading-exams assets/generated/reading-explanations assets/generated/listening-exams'

case "${1:-}" in
    '') run_once=false ;;
    --once) run_once=true ;;
    *)
        echo "Usage: $0 [--once]" >&2
        exit 64
        ;;
esac

case "$interval" in
    ''|*[!0-9]*)
        echo "QUESTION_BANK_CHECK_INTERVAL_SECONDS must be a positive integer" >&2
        exit 64
        ;;
esac

if [ "$interval" -le 0 ]; then
    echo "QUESTION_BANK_CHECK_INTERVAL_SECONDS must be a positive integer" >&2
    exit 64
fi

if ! command -v git >/dev/null 2>&1; then
    echo "git is required to update the question bank" >&2
    exit 69
fi

if [ ! -d "$repo_root/.git" ]; then
    echo "Expected a Git checkout at $repo_root" >&2
    exit 69
fi

read_version() {
    sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$1" | head -n 1
}

update_once() {
    cd "$repo_root"
    git fetch --quiet "$remote" "$branch"

    remote_version=$(git show "FETCH_HEAD:$version_file" 2>/dev/null | sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
    local_version=''
    if [ -f "$version_file" ]; then
        local_version=$(read_version "$version_file")
    fi

    if [ -z "$remote_version" ]; then
        echo "Remote $remote/$branch does not contain a valid $version_file" >&2
        return 1
    fi
    if [ "$remote_version" = "$local_version" ]; then
        echo "Question bank is already current ($remote_version)."
        return 0
    fi

    # Restore assets first. Publish the version file last so browsers only see
    # the new version after the replacement assets are already present.
    git restore --worktree --source=FETCH_HEAD -- $asset_paths
    git restore --worktree --source=FETCH_HEAD -- "$version_file"
    echo "Question bank updated to $remote_version from $remote/$branch."
}

if [ "$run_once" = true ]; then
    update_once
    exit $?
fi

while true; do
    if ! update_once; then
        echo "Question-bank update check failed; retrying in $interval seconds." >&2
    fi
    sleep "$interval"
done
