"""Lightweight in-memory request/activity monitor for the SA load panel.

Single-worker Render instance, so a plain module-level store is fine — it resets on
restart/cold-start, which is itself useful (uptime_seconds tells you when the box last
woke). Everything is bounded to a 15-min rolling window; memory stays tiny."""
import time
from collections import deque
from threading import Lock

_BOOT = time.time()
_WINDOW = 900          # keep the last 15 minutes
_lock = Lock()
_requests = deque()    # (ts, duration_ms, status_code)
_active = {}           # user_id -> last_seen_ts (authenticated activity)
_auths = deque()       # (ts, local_bool) — did this auth use local JWT verify or the slow fallback?
_total = 0             # all requests since boot (not trimmed)


def _trim(now: float):
    cutoff = now - _WINDOW
    while _requests and _requests[0][0] < cutoff:
        _requests.popleft()
    while _auths and _auths[0][0] < cutoff:
        _auths.popleft()
    for u in [u for u, t in _active.items() if t < cutoff]:
        del _active[u]


def record_auth(local: bool):
    now = time.time()
    with _lock:
        _auths.append((now, bool(local)))
        _trim(now)


def record_request(duration_ms: float, status: int):
    global _total
    now = time.time()
    with _lock:
        _total += 1
        _requests.append((now, duration_ms, status))
        _trim(now)


def record_user(user_id: str):
    if not user_id:
        return
    now = time.time()
    with _lock:
        _active[user_id] = now


def _rss_mb():
    """Current process resident memory in MB (Render free tier hides this, so we self-report)."""
    try:
        with open("/proc/self/status") as f:
            for line in f:
                if line.startswith("VmRSS:"):
                    return round(int(line.split()[1]) / 1024, 1)   # KB → MB
    except Exception:
        return None
    return None

def snapshot() -> dict:
    now = time.time()
    with _lock:
        _trim(now)
        reqs = list(_requests)
        active_ts = list(_active.values())
        auths = list(_auths)
        total = _total
    def reqs_since(sec):
        c = now - sec
        return sum(1 for (t, _d, _s) in reqs if t >= c)
    def users_since(sec):
        c = now - sec
        return sum(1 for t in active_ts if t >= c)
    # Latency percentiles use a SHORT 2-min window so they reflect "current" speed: a 5-min window
    # over sparse traffic stays dominated by stale cold-start requests and falsely reads 吃緊 while
    # the server is actually idle. samples over this window drive the idle/insufficient guard.
    recent = sorted(d for (t, d, _s) in reqs if t >= now - 120)
    auth_recent = [lo for (t, lo) in auths if t >= now - 300]
    def pct(p):
        if not recent:
            return 0
        k = max(0, min(len(recent) - 1, int(round((p / 100) * (len(recent) - 1)))))
        return int(recent[k])
    return {
        "uptime_seconds": int(now - _BOOT),
        "active_5m": users_since(300),
        "active_15m": users_since(900),
        "req_1m": reqs_since(60),
        "req_5m": reqs_since(300),
        "rps_1m": round(reqs_since(60) / 60, 2),
        "p50_ms_5m": pct(50),                                   # 中位數：反映「典型體感」，不被冷啟動離群值帶歪
        "p95_ms_5m": pct(95),                                   # 最慢 5%：看尾端 / 抓特別高的值
        "max_ms_5m": int(recent[-1]) if recent else 0,
        "avg_ms_5m": int(sum(recent) / len(recent)) if recent else 0,
        "samples_5m": len(recent),
        "errors_5m": sum(1 for (t, _d, s) in reqs if t >= now - 300 and s >= 500),
        "auth_total_5m": len(auth_recent),
        "auth_local_5m": sum(1 for lo in auth_recent if lo),   # how many auths used local JWT verify
        "mem_mb": _rss_mb(),
        "mem_limit_mb": 512,
        "total_since_boot": total,
    }
