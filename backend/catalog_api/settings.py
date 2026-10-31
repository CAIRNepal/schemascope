"""Where the catalog data and the database live. The same code serves SchemaScope and NeuroSchema;
only the repository (site.config.json + data/) differs."""
from __future__ import annotations

import json
import os
from functools import lru_cache
from pathlib import Path

# backend/ sits at the repository root, next to data/ and site.config.json.
REPO_ROOT = Path(os.environ.get("CATALOG_REPO", Path(__file__).resolve().parents[2]))
DATA_DIR = Path(os.environ.get("CATALOG_DATA", REPO_ROOT / "data"))
# Contributors' local previews (PREVIEW=1 / CI) write here; the newer evaluation of the two wins.
LOCAL_DATA_DIR = REPO_ROOT / ".local" / "data"
DB_PATH = Path(os.environ.get("CATALOG_DB", REPO_ROOT / ".local" / "catalog.db"))
# Comma-separated origins allowed to call the API from a browser.
CORS_ORIGINS = [o.strip() for o in os.environ.get("CORS_ORIGINS", "*").split(",") if o.strip()]
# Host names the MCP endpoint answers to (DNS-rebinding protection), e.g. "api.schemascope.org".
# Localhost is always allowed; set this in production.
MCP_ALLOWED_HOSTS = [h.strip() for h in os.environ.get("MCP_ALLOWED_HOSTS", "").split(",") if h.strip()]


@lru_cache
def site_config() -> dict:
    path = REPO_ROOT / "site.config.json"
    return json.loads(path.read_text()) if path.exists() else {"name": "Catalog", "url": ""}
