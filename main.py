import os
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from config import settings
from routers import auth, novels, chapters, permissions, invites, feedback

app = FastAPI(title="預言家日報 API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

import time as _time
from monitor import record_request

@app.middleware("http")
async def _monitor_requests(request, call_next):
    start = _time.perf_counter()
    response = await call_next(request)
    try:
        # Don't let the monitor measure its own poll (every 10s) — that would bias the
        # latency stats toward the auth-heavy /server-stats request when real traffic is low.
        if not request.url.path.endswith("/server-stats"):
            record_request((_time.perf_counter() - start) * 1000, response.status_code)
    except Exception:
        pass
    return response

@app.on_event("startup")
async def _on_startup():
    # Sync endpoints run in a threadpool (default 40). Each in-flight request allocates, so on a
    # 512MB free instance 40 concurrent requests can spike memory over the limit (OOM). Cap to 15:
    # plenty for our scale, and excess requests just queue briefly instead of blowing up RAM.
    import anyio
    try:
        anyio.to_thread.current_default_thread_limiter().total_tokens = 15
    except Exception:
        pass
    # One-shot, self-terminating migration: bring any seeded 作家入職指南 that STILL contains the
    # old trial-period text up to the current template. Matching on the old text means it only
    # touches unedited guides (won't clobber a writer who repurposed theirs) and becomes a no-op
    # once every guide is updated — so no recurring button is needed.
    try:
        from deps import get_supabase_admin
        from guide_content import GUIDE_TITLE, GUIDE_BODY
        sb = get_supabase_admin()
        ids = [g["id"] for g in (sb.table("novels").select("id").eq("is_guide", True).execute().data or [])]
        if ids:
            stale = sb.table("chapters").select("id, novel_id").in_("novel_id", ids).ilike("content", "%可能會遇到的異常狀況%").execute().data or []
            for ch in stale:
                sb.table("chapters").update({"content": GUIDE_BODY}).eq("id", ch["id"]).execute()
            for nid in {ch["novel_id"] for ch in stale}:
                sb.table("novels").update({"title": GUIDE_TITLE}).eq("id", nid).execute()
    except Exception:
        pass

app.include_router(auth.router,        prefix="/auth",        tags=["auth"])
app.include_router(novels.router,      prefix="/novels",      tags=["novels"])
app.include_router(chapters.router,    prefix="/chapters",    tags=["chapters"])
app.include_router(permissions.router, prefix="/permissions", tags=["permissions"])
app.include_router(invites.router,     prefix="/invites",     tags=["invites"])
app.include_router(feedback.router,    prefix="/feedback",    tags=["feedback"])

# GET + HEAD so uptime monitors (e.g. UptimeRobot, which probes with HEAD) get 200.
@app.api_route("/health", methods=["GET", "HEAD"])
def health():
    return {"status": "ok"}

# ── Serve the frontend straight from this backend ──────────────────────────────
# The static frontend normally lives on GitHub Pages (surf0912.github.io), but that host is
# blocked on some mainland-China networks while THIS origin (onrender.com) is reachable. Serving
# index.html + assets here gives those users a working mirror at the same origin as the API — so
# there's no CORS hop, and invite links (which use location.origin) just work. Every API route
# above is registered first and takes precedence; only unmatched paths fall through to the files
# below.
app.mount("/chars", StaticFiles(directory="chars"), name="chars")

# Top-level static assets we allow, by extension. Excludes .py so backend source is never served,
# and the guard blocks path traversal — even though the repo is already public.
_STATIC_EXT = {".woff2", ".jpg", ".jpeg", ".png", ".svg", ".json", ".js", ".ico"}

@app.get("/")
def _frontend_index():
    return FileResponse("index.html")

@app.get("/{name}")
def _frontend_asset(name: str):
    if "/" in name or ".." in name:
        raise HTTPException(404)
    if os.path.splitext(name)[1].lower() in _STATIC_EXT and os.path.isfile(name):
        return FileResponse(name)
    raise HTTPException(404)
