from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
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

app.include_router(auth.router,        prefix="/auth",        tags=["auth"])
app.include_router(novels.router,      prefix="/novels",      tags=["novels"])
app.include_router(chapters.router,    prefix="/chapters",    tags=["chapters"])
app.include_router(permissions.router, prefix="/permissions", tags=["permissions"])
app.include_router(invites.router,     prefix="/invites",     tags=["invites"])
app.include_router(feedback.router,    prefix="/feedback",    tags=["feedback"])

@app.get("/")
def root():
    return {"message": "預言家日報 API is running"}

# GET + HEAD so uptime monitors (e.g. UptimeRobot, which probes with HEAD) get 200.
@app.api_route("/health", methods=["GET", "HEAD"])
def health():
    return {"status": "ok"}
