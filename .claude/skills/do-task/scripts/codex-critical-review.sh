#!/usr/bin/env bash
# Pipe CriticalReview prompt into codex exec (do-task Step4).
# Usage: .cursor/skills/do-task/scripts/codex-critical-review.sh <TASK_MD_PATH> [BASE_BRANCH]
#   bash .cursor/skills/do-task/scripts/codex-critical-review.sh docs/tasks/014-01-foo.md main
set -euo pipefail
TASK="${1:?Usage: $0 <TASK_MD_PATH> [BASE_BRANCH]}"
BASE="${2:-main}"
# Repo root: .../do-task/scripts -> ../../../../
ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
PROMPT="$ROOT/.cursor/skills/do-task/templates/codex-critical-review.prompt"
if [[ ! -f "$PROMPT" ]]; then
  echo "Missing template: $PROMPT" >&2
  exit 1
fi
sed "s|<TASK_MD_PATH>|$TASK|g; s|<BASE_BRANCH>|$BASE|g" "$PROMPT" | \
  codex exec -c 'sandbox_mode=workspace-write' -c 'approval_policy=never' -
