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
_total = 0             # all requests since boot (not trimmed)


def _trim(now: float):
    cutoff = now - _WINDOW
    while _requests and _requests[0][0] < cutoff:
        _requests.popleft()
    for u in [u for u, t in _active.items() if t < cutoff]:
        del _active[u]


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


def snapshot() -> dict:
    now = time.time()
    with _lock:
        _trim(now)
        reqs = list(_requests)
        active_ts = list(_active.values())
        total = _total
    def reqs_since(sec):
        c = now - sec
        return sum(1 for (t, _d, _s) in reqs if t >= c)
    def users_since(sec):
        c = now - sec
        return sum(1 for t in active_ts if t >= c)
    recent = [d for (t, d, _s) in reqs if t >= now - 300]
    return {
        "uptime_seconds": int(now - _BOOT),
        "active_5m": users_since(300),
        "active_15m": users_since(900),
        "req_1m": reqs_since(60),
        "req_5m": reqs_since(300),
        "rps_1m": round(reqs_since(60) / 60, 2),
        "avg_ms_5m": int(sum(recent) / len(recent)) if recent else 0,
        "errors_5m": sum(1 for (t, _d, s) in reqs if t >= now - 300 and s >= 500),
        "total_since_boot": total,
    }
