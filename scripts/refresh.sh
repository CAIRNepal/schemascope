#!/usr/bin/env bash
# Run the full evaluation locally, rebuild the static site, and (optionally) commit + push the results.
# The maintainer's local run is the only writer of data/evaluation.json, data/runs/ and data/quality/;
# GitHub Actions only handle submissions, so these files never conflict.
#
#   scripts/refresh.sh              quality checks + evaluation + build, then commit (no push)
#   scripts/refresh.sh --push       ... and push to origin
#   scripts/refresh.sh --quick      skip the slow ontology quality checks (reuses data/quality/)
#   ONLY=id1,id2 scripts/refresh.sh evaluate just these entries
#   MAX_MINUTES=60 scripts/refresh.sh  time budget for quality checks (default 120; stalest first, resumes next run)
#
# Requirements: Node ≥ 18, Docker (OOPS! and ROBOT images, built automatically), Python 3 with rdflib.
# Optional: GITHUB_TOKEN (or a logged-in `gh` CLI) to avoid GitHub's 60 requests/hour limit; BIOPORTAL_API_KEY.
set -euo pipefail
cd "$(dirname "$0")/.."

PUSH=0; QUICK=0
for arg in "$@"; do
  case "$arg" in
    --push) PUSH=1 ;;
    --quick) QUICK=1 ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

NAME=$(node -e 'console.log(require("./package.json").name)')
step() { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }

step "Updating from origin"
BRANCH=$(git branch --show-current)
if git remote get-url origin >/dev/null 2>&1 && git ls-remote --exit-code --heads origin "$BRANCH" >/dev/null 2>&1; then
  git pull --rebase --autostash origin "$BRANCH" || { echo "git pull failed; resolve and re-run." >&2; exit 1; }
else
  echo "origin/$BRANCH not found (not pushed yet?); skipping pull."
fi

if [ -z "${GITHUB_TOKEN:-}" ] && command -v gh >/dev/null 2>&1; then
  GITHUB_TOKEN=$(gh auth token 2>/dev/null || true); export GITHUB_TOKEN
fi
[ -n "${GITHUB_TOKEN:-}" ] || echo "note: no GITHUB_TOKEN; GitHub lookups are limited to 60/hour (failed ones are carried forward)."

step "Validating catalog"
node scripts/validate.mjs

if [ "$QUICK" = 0 ]; then
  step "Building analysis images (cached)"
  docker build -q -t "$NAME/oops" docker/oops >/dev/null
  docker build -q -t "$NAME/robot" docker/robot >/dev/null
  step "Ontology quality: ROBOT reasoner + report, OOPS! pitfalls (Python fallback)"
  OOPS_IMAGE="$NAME/oops" ROBOT_IMAGE="$NAME/robot" SKIP_OOPS_WEB="${SKIP_OOPS_WEB:-1}" node scripts/quality.mjs
fi

step "Evaluating (FAIR, quality, maintenance, adoption, provenance)"
node scripts/evaluate.mjs | grep -v -E '^\s+[0-9]+ [A-E] ' || true

step "Building static site"
node scripts/build.mjs

# Load the new results into the API database (backend/), if the Python stack is set up here.
if command -v uv >/dev/null 2>&1 && [ -f backend/pyproject.toml ]; then
  step "Loading results into the API database"
  (cd backend && uv run -q python -m catalog_api.ingest)
fi

step "Committing results"
git add data/evaluation.json data/runs data/quality 2>/dev/null || true
if git diff --cached --quiet; then
  echo "No changes to commit."
else
  RUN=$(node -e 'console.log(require("./data/evaluation.json").run?.id || "")')
  git commit -q -m "Evaluation run ${RUN}" -m "Generated locally by scripts/refresh.sh"
  echo "Committed evaluation run ${RUN}."
fi

if [ "$PUSH" = 1 ]; then
  step "Pushing"
  git push origin "$(git branch --show-current)"
else
  echo; echo "Done. Preview: npm run serve   Publish: git push"
fi
