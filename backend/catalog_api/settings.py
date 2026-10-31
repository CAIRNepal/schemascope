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
# Postgres (docker compose up -d db). Catalog, run history, accounts and the audit log live here.
DATABASE_URL = os.environ.get("DATABASE_URL", "postgresql://catalog:catalog@127.0.0.1:5433/catalog")
DB_POOL_SIZE = int(os.environ.get("DB_POOL_SIZE", 10))
# Comma-separated origins allowed to call the API from a browser.
CORS_ORIGINS = [o.strip() for o in os.environ.get("CORS_ORIGINS", "*").split(",") if o.strip()]
# Host names the MCP endpoint answers to (DNS-rebinding protection), e.g. "api.schemascope.org".
# Localhost is always allowed; set this in production.
MCP_ALLOWED_HOSTS = [h.strip() for h in os.environ.get("MCP_ALLOWED_HOSTS", "").split(",") if h.strip()]


@lru_cache
def site_config() -> dict:
    path = REPO_ROOT / "site.config.json"
    return json.loads(path.read_text()) if path.exists() else {"name": "Catalog", "url": ""}


# ---------- public URLs (never hard-coded; set these per deployment) ----------
def _url(env: str, default: str) -> str:
    return (os.environ.get(env) or default).rstrip("/")


# Where people reach the site, used for sign-in redirects and links in API docs and issue bodies.
# Defaults to site.config.json's url; set PUBLIC_SITE_URL for local or staging runs (e.g. http://localhost:3000).
PUBLIC_SITE_URL = _url("PUBLIC_SITE_URL", site_config().get("url", ""))
# Session cookies are Secure when the site is served over https.
COOKIE_SECURE = os.environ.get("COOKIE_SECURE", "1" if PUBLIC_SITE_URL.startswith("https://") else "0") == "1"
# Where API clients reach the API. The site server proxies /api/ and /mcp/, so this is normally the site URL.
PUBLIC_API_URL = _url("PUBLIC_API_URL", PUBLIC_SITE_URL)

# ---------- accounts, sign-in and rate limits ----------
# GitHub logins that may read the full audit log (comma-separated).
ADMIN_LOGINS = {x.strip().lower() for x in os.environ.get("ADMIN_LOGINS", "").split(",") if x.strip()}
# GitHub OAuth app (Settings → Developer settings → OAuth Apps). Callback URL: <PUBLIC_SITE_URL>/api/auth/github/callback
GITHUB_CLIENT_ID = os.environ.get("GITHUB_CLIENT_ID", "")
GITHUB_CLIENT_SECRET = os.environ.get("GITHUB_CLIENT_SECRET", "")
# Local testing without a GitHub app: DEV_LOGIN=1 enables /api/auth/dev-login. Never set it in production.
DEV_LOGIN = os.environ.get("DEV_LOGIN") == "1"
SESSION_HOURS = float(os.environ.get("SESSION_HOURS", 8))
# Requests per minute: anonymous (per IP) and signed in (per user, session or token).
RATE_LIMIT_ANON = int(os.environ.get("RATE_LIMIT_ANON", 60))
RATE_LIMIT_USER = int(os.environ.get("RATE_LIMIT_USER", 1000))
# Proxies whose X-Forwarded-For is trusted for the client IP (the site server runs on the same host by default).
TRUSTED_PROXIES = {h.strip() for h in os.environ.get("TRUSTED_PROXIES", "127.0.0.1,::1").split(",") if h.strip()}
# Token prefix, so leaked tokens are recognisable (e.g. by secret scanners).
TOKEN_PREFIX = os.environ.get("TOKEN_PREFIX", f"{site_config().get('brand', 'cat')[:3].lower()}_pat_")


def jwt_secret() -> str:
    """JWT_SECRET from the environment; for local runs a random secret is created once in .local/."""
    if os.environ.get("JWT_SECRET"):
        return os.environ["JWT_SECRET"]
    f = REPO_ROOT / ".local" / "jwt-secret"
    if not f.exists():
        import secrets

        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(secrets.token_urlsafe(48))
        f.chmod(0o600)
    return f.read_text().strip()
