import time
import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from config import settings
from deps import get_supabase, get_supabase_admin, get_current_user, ROLE_RANK, invalidate_profile
from supabase import Client
from guide_content import GUIDE_TITLE, GUIDE_AUTHOR, GUIDE_BODY

router = APIRouter()

INTERNAL_DOMAIN = "prophet-daily.internal"

def username_to_email(username: str) -> str:
    return f"{username.lower()}@{INTERNAL_DOMAIN}"

# ── Brute-force lockout (in-memory; per username AND per client IP) ──
# After MAX_FAILS failed attempts within WINDOW seconds, that key is locked
# until the oldest counted failure ages out of the window.
_FAILS: dict[str, list[float]] = {}
_WINDOW = 900  # 15 minutes
# Per-username lock is the main defence (targeted account); per-IP is a looser net
# for username-rotation attacks, set high so a shared home network isn't locked easily.
_MAX = {"u": 6, "ip": 20}

def _max_for(key: str) -> int:
    return _MAX.get(key.split(":", 1)[0], 6)

def _recent(key: str) -> list[float]:
    now = time.time()
    fails = [t for t in _FAILS.get(key, []) if now - t < _WINDOW]
    if fails:
        _FAILS[key] = fails
    else:
        _FAILS.pop(key, None)
    return fails

def _check_locked(keys: list[str]):
    for k in keys:
        fails = _recent(k)
        if len(fails) >= _max_for(k):
            wait = int((_WINDOW - (time.time() - min(fails))) / 60) + 1
            raise HTTPException(429, f"嘗試次數過多，請約 {wait} 分鐘後再試")

def _record_fail(keys: list[str]):
    now = time.time()
    for k in keys:
        _FAILS.setdefault(k, []).append(now)

class SignInRequest(BaseModel):
    username: str
    password: str

class SignUpRequest(BaseModel):
    username: str
    password: str

@router.post("/signin")
def signin(body: SignInRequest, request: Request, sb: Client = Depends(get_supabase), sb_admin: Client = Depends(get_supabase_admin)):
    uname = (body.username or "").lower().strip()
    ip = (request.headers.get("x-forwarded-for", "").split(",")[0].strip()
          or (request.client.host if request.client else "?"))
    keys = [f"u:{uname}", f"ip:{ip}"]
    _check_locked(keys)

    email = username_to_email(body.username)
    try:
        res = sb.auth.sign_in_with_password({"email": email, "password": body.password})
        ok = res.session is not None
    except Exception:
        ok = False
    if not ok:
        _record_fail(keys)
        raise HTTPException(401, "用戶名或密碼錯誤")

    # Block banned accounts at the door with a clear message.
    try:
        prof = sb_admin.table("profiles").select("banned").eq("id", res.user.id).single().execute()
        if prof.data and prof.data.get("banned"):
            raise HTTPException(403, "此帳號已被封禁，如有疑問請聯絡管理員")
    except HTTPException:
        raise
    except Exception:
        pass

    for k in keys:  # success clears the counters
        _FAILS.pop(k, None)
    return {
        "access_token": res.session.access_token,
        "refresh_token": res.session.refresh_token,
        "user": {"id": res.user.id},
    }

class RefreshBody(BaseModel):
    refresh_token: str

@router.post("/refresh")
def refresh_token(body: RefreshBody):
    # Exchange a refresh token for a fresh access token (GoTrue REST) so users aren't
    # force-logged-out when the ~1h access token expires.
    try:
        r = httpx.post(
            f"{settings.supabase_url}/auth/v1/token",
            params={"grant_type": "refresh_token"},
            headers={"apikey": settings.supabase_anon_key, "Content-Type": "application/json"},
            json={"refresh_token": body.refresh_token},
            timeout=10,
        )
    except Exception:
        raise HTTPException(503, "續期服務暫時無法使用")
    if r.status_code != 200:
        raise HTTPException(401, "工作階段已過期，請重新登入")
    d = r.json()
    return {
        "access_token": d.get("access_token"),
        "refresh_token": d.get("refresh_token"),
        "user": {"id": (d.get("user") or {}).get("id")},
    }

def maybe_seed_guide(user: dict, sb_admin: Client):
    # Once per writer (and above), drop a deletable 作家入職指南 demo work into their
    # 作品管理 (status=approved + is_guide=True → hidden from the public shelf/review).
    # Lazy: runs on /auth/me, so it covers both new writers and existing ones on next login.
    if ROLE_RANK.get(user.get("role"), 0) < ROLE_RANK["writer"]:
        return
    if user.get("guide_seeded"):
        return
    try:
        nv = sb_admin.table("novels").insert({
            "title": GUIDE_TITLE,
            "author": GUIDE_AUTHOR,
            "kind": "novel",
            "status": "approved",
            "is_guide": True,
            "owners": [user["id"]],
            "created_by": user["id"],
        }).execute()
        novel_id = nv.data[0]["id"]
        sb_admin.table("chapters").insert({
            "novel_id": novel_id,
            "chapter_num": 1,
            "title": None,
            "content": GUIDE_BODY,
            "created_by": user["id"],
        }).execute()
        sb_admin.table("profiles").update({"guide_seeded": True}).eq("id", user["id"]).execute()
        user["guide_seeded"] = True
    except Exception:
        pass  # never let seeding break login (e.g. column not yet added)

def _touch_last_seen(user: dict, sb_admin: Client):
    """Record activity for the 不活躍用戶 report. /me fires on every app open + token refresh,
    so this reflects true activity (unlike auth.last_sign_in_at, which is stale under refresh).
    Throttled to ~30 min to avoid a write per call. Requires a profiles.last_seen_at timestamptz
    column; silently no-ops if the column is missing."""
    from datetime import datetime, timezone, timedelta
    now = datetime.now(timezone.utc)
    last = user.get("last_seen_at")
    if last:
        try:
            if now - datetime.fromisoformat(str(last).replace("Z", "+00:00")) < timedelta(minutes=30):
                return
        except Exception:
            pass
    try:
        sb_admin.table("profiles").update({"last_seen_at": now.isoformat()}).eq("id", user["id"]).execute()
        user["last_seen_at"] = now.isoformat()
    except Exception:
        pass

@router.get("/me")
def me(user: dict = Depends(get_current_user), sb_admin: Client = Depends(get_supabase_admin)):
    maybe_seed_guide(user, sb_admin)
    _touch_last_seen(user, sb_admin)
    return user

class NicknameBody(BaseModel):
    nickname: str

@router.patch("/me/nickname")
def update_nickname(body: NicknameBody, user: dict = Depends(get_current_user), sb_admin: Client = Depends(get_supabase_admin)):
    nick = (body.nickname or "").strip()
    if not nick:
        raise HTTPException(400, "巫師姓名不能空白")
    if len(nick) > 20:
        raise HTTPException(400, "巫師姓名最多 20 字")
    res = sb_admin.table("profiles").update({"nickname": nick}).eq("id", user["id"]).execute()
    if not res.data:
        raise HTTPException(404, "User not found")
    invalidate_profile(user["id"])
    return res.data[0]

class TourSeenBody(BaseModel):
    version: str = "2"

@router.patch("/me/tour-seen")
def set_tour_seen(body: TourSeenBody, user: dict = Depends(get_current_user), sb_admin: Client = Depends(get_supabase_admin)):
    # Records which onboarding-tour version this account has completed (cross-device,
    # once-ever). Requires a profiles.tour_seen text column.
    res = sb_admin.table("profiles").update({"tour_seen": body.version}).eq("id", user["id"]).execute()
    if not res.data:
        raise HTTPException(404, "User not found")
    invalidate_profile(user["id"])
    return {"tour_seen": body.version}

class ChangePwBody(BaseModel):
    current: str
    new: str

@router.patch("/me/password")
def change_my_password(body: ChangePwBody, user: dict = Depends(get_current_user),
                       sb: Client = Depends(get_supabase), sb_admin: Client = Depends(get_supabase_admin)):
    new = (body.new or "").strip()
    if len(new) < 6:
        raise HTTPException(400, "新通關密語至少 6 字")
    # Verify the current password by attempting a sign-in (accounts use internal emails).
    email = username_to_email(user.get("username", ""))
    try:
        res = sb.auth.sign_in_with_password({"email": email, "password": body.current})
        ok = res.session is not None
    except Exception:
        ok = False
    if not ok:
        raise HTTPException(403, "目前的通關密語不正確")
    sb_admin.auth.admin.update_user_by_id(user["id"], {"password": new})
    return {"message": "ok"}

class AvatarBody(BaseModel):
    avatar: str  # small client-resized data URL (data:image/...;base64,...), or '' to clear

@router.patch("/me/avatar")
def update_avatar(body: AvatarBody, user: dict = Depends(get_current_user), sb_admin: Client = Depends(get_supabase_admin)):
    av = (body.avatar or "").strip()
    if av and not av.startswith("data:image/"):
        raise HTTPException(400, "頭像格式不正確")
    if len(av) > 200_000:  # ~200KB ceiling; the client resizes to ~15KB
        raise HTTPException(400, "頭像檔案太大，請換小一點的圖")
    res = sb_admin.table("profiles").update({"avatar_url": av or None}).eq("id", user["id"]).execute()
    if not res.data:
        raise HTTPException(404, "User not found")
    invalidate_profile(user["id"])
    return res.data[0]
