# API + MCP server (FastAPI). Also runs the ingest job, which needs Node to read scripts/rubric.mjs and
# compute run history with scripts/site.mjs, exactly as the static build does.
FROM python:3.13-slim
RUN apt-get update && apt-get install -y --no-install-recommends nodejs ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=ghcr.io/astral-sh/uv:0.9.15 /uv /bin/uv
WORKDIR /app/backend
COPY backend/pyproject.toml backend/uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY backend/ ./
COPY scripts/ /app/scripts/
COPY site.config.json /app/
ENV CATALOG_REPO=/app PATH=/app/backend/.venv/bin:$PATH PYTHONUNBUFFERED=1
# data/ is mounted read-only at /app/data (the repository's data folder, updated by evaluation runs).
EXPOSE 8000
USER nobody
CMD ["uvicorn", "catalog_api.app:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*"]
