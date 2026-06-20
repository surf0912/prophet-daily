import time
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from deps import get_supabase, get_supabase_admin, get_current_user
from supabase import Client

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
def signin(body: SignInRequest, request: Request, sb: Client = Depends(get_supabase)):
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

    for k in keys:  # success clears the counters
        _FAILS.pop(k, None)
    return {
        "access_token": res.session.access_token,
        "refresh_token": res.session.refresh_token,
        "user": {"id": res.user.id},
    }

@router.get("/me")
def me(user: dict = Depends(get_current_user)):
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
    return {"tour_seen": body.version}

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
    return res.data[0]
