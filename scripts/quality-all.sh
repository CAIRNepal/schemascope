#!/usr/bin/env bash
# Run the quality checks (ROBOT, pitfall scan, imports read from the file) on every ontology, with no time limit.
# Safe to stop and re-run: ontologies checked in the last QUALITY_SKIP_DAYS days (default 30) are skipped.
#   npm run quality:all                    all ontologies not checked in the last 30 days
#   QUALITY_JOBS=3 npm run quality:all     three at a time (Docker's memory is shared between them)
# Results go to data/quality/; run `npm run rescore` (or `npm run refresh`) afterwards to update scores.
set -euo pipefail
cd "$(dirname "$0")/.."
NAME=$(node -p 'require("./package.json").name')
docker build -q -t "$NAME/oops" docker/oops >/dev/null
docker build -q -t "$NAME/robot" docker/robot >/dev/null
MAX_MINUTES="${MAX_MINUTES:-1000000}" QUALITY_SKIP_DAYS="${QUALITY_SKIP_DAYS:-30}" \
  OOPS_IMAGE="$NAME/oops" ROBOT_IMAGE="$NAME/robot" SKIP_OOPS_WEB="${SKIP_OOPS_WEB:-1}" \
  node scripts/quality.mjs
