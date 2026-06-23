from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from config import settings
from supabase import create_client, Client
import base64, binascii, jwt, re, time
from jwt import PyJWKClient

bearer = HTTPBearer()

ROLE_RANK = {'super_admin': 4, 'admin': 3, 'writer': 2, 'reader': 1}

_IMAGE_DATA_RE = re.compile(r"^data:image/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$")

def validate_image_data_url(value: str, max_chars: int) -> str:
    """Accept only real base64 JPEG/PNG/WebP data URLs.

    A prefix-only `data:image/` check is unsafe because the value is later rendered inside
    HTML/CSS. Restricting the MIME type, alphabet, padding, and file signature prevents a
    crafted avatar from breaking out of an attribute and becoming stored XSS. SVG is
    deliberately excluded because it can contain active content.
    """
    value = (value or "").strip()
    if not value:
        return ""
    if len(value) > max_chars:
        raise HTTPException(400, "頭像檔案太大，請換小一點的圖")
    match = _IMAGE_DATA_RE.fullmatch(value)
    if not match:
        raise HTTPException(400, "頭像格式不正確，請使用 JPEG、PNG 或 WebP")
    kind, payload = match.groups()
    try:
        raw = base64.b64decode(payload, validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(400, "頭像資料損毀")
    valid_signature = (
        (kind == "jpeg" and raw.startswith(b"\xff\xd8\xff"))
        or (kind == "png" and raw.startswith(b"\x89PNG\r\n\x1a\n"))
        or (kind == "webp" and len(raw) >= 12 and raw[:4] == b"RIFF" and raw[8:12] == b"WEBP")
    )
    if not valid_signature:
        raise HTTPException(400, "頭像內容與圖片格式不符")
    return value

# Short-lived in-process cache of the profile row, so every authenticated request doesn't re-fetch
# it from Supabase. Every endpoint that mutates a profile (role/ban/mqj/nickname/avatar/…) calls
# invalidate_profile(), so changes are effectively instant; the TTL is just a safety net for any
# out-of-band edit (e.g. editing the row directly in the Supabase dashboard).
_PROFILE_TTL = 60          # seconds
_profile_cache: dict = {}  # user_id -> (profile_dict, fetched_at)

def invalidate_profile(user_id: str):
    _profile_cache.pop(user_id, None)

# Public JWKS for asymmetric (ES256/RS256) access tokens — fetched once and cached in-process,
# so verification stays local after the first hit. New Supabase projects sign with ES256.
_jwks_client = None
def _jwks():
    global _jwks_client
    if _jwks_client is None:
        url = settings.supabase_url.rstrip("/") + "/auth/v1/.well-known/jwks.json"
        _jwks_client = PyJWKClient(url, cache_keys=True)
    return _jwks_client

def _verify_jwt_local(token: str):
    """Validate a Supabase access token locally so we skip the network round-trip to the Auth
    server on every authenticated request. Migrated projects sign with an asymmetric key (ES256),
    verified against the project's public JWKS (cached); legacy/older tokens use the HS256 shared
    secret. Returns the user id (sub), or None when it can't decide so the caller falls back to
    sb.auth.get_user(). Signature + expiry are always enforced."""
    # 1) Asymmetric (ES256/RS256) via the project's public JWKS — the default for migrated projects.
    try:
        alg = (jwt.get_unverified_header(token).get("alg") or "")
        if alg and alg.upper() != "HS256":
            key = _jwks().get_signing_key_from_jwt(token).key
            return jwt.decode(token, key, algorithms=[alg], options={"verify_aud": False}).get("sub")
    except Exception:
        pass
    # 2) Legacy HS256 shared secret (older tokens / projects not yet migrated).
    secret = getattr(settings, "jwt_secret", "") or ""
    if secret:
        try:
            return jwt.decode(token, secret, algorithms=["HS256"], options={"verify_aud": False}).get("sub")
        except Exception:
            pass
    return None

def get_supabase() -> Client:
    # Anon client is used for auth flows (sign-in / get_user) which carry per-call session state,
    # so it stays per-request — don't share it across users.
    return create_client(settings.supabase_url, settings.supabase_anon_key)

# Service-role client is stateless for our usage (.table() REST + admin API), so reuse ONE instance
# across all requests instead of building a new httpx/supabase client on every call. This is the
# hot path — get_current_user + every endpoint hit it — so it shaves real per-request overhead.
_admin_client: Client = None
def get_supabase_admin() -> Client:
    global _admin_client
    if _admin_client is None:
        _admin_client = create_client(settings.supabase_url, settings.supabase_service_key)
    return _admin_client

def get_current_user(
    creds: HTTPAuthorizationCredentials = Depends(bearer),
    sb_admin: Client = Depends(get_supabase_admin),
):
    token = creds.credentials
    # Fast path: verify the JWT locally (no network, no client). Falls back to the Auth server only
    # when local verification can't decide — and only THEN do we build an anon client. Building it
    # on every request (the old Depends) leaked memory and was OOM-ing the 512MB free instance.
    user_id = _verify_jwt_local(token)
    used_local = user_id is not None
    if not user_id:
        try:
            auth_user = get_supabase().auth.get_user(token)
            user_id = auth_user.user.id
        except Exception:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")

    now = time.time()
    cached = _profile_cache.get(user_id)
    if cached and now - cached[1] < _PROFILE_TTL:
        profile = cached[0]
    else:
        rows = sb_admin.table("profiles").select("*").eq("id", user_id).limit(1).execute().data
        if not rows:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")
        profile = rows[0]
        _profile_cache[user_id] = (profile, now)
    if profile.get("banned"):
        _profile_cache.pop(user_id, None)   # never let a ban linger in cache
        # 401 so the client drops the session and returns to the login screen.
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="此帳號已被封禁")
    try:
        from monitor import record_user, record_auth
        record_user(user_id)
        record_auth(used_local)
    except Exception:
        pass
    return profile

def _require_role(min_role: str):
    def dep(user: dict = Depends(get_current_user)):
        if ROLE_RANK.get(user.get("role"), 0) < ROLE_RANK[min_role]:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=f"Requires {min_role} or above")
        return user
    return dep

# Convenience role guards
require_admin       = _require_role("admin")        # admin + super_admin
require_writer      = _require_role("writer")       # writer + admin + super_admin
require_super_admin = _require_role("super_admin")

def is_admin(user: dict) -> bool:
    return ROLE_RANK.get(user.get("role"), 0) >= ROLE_RANK["admin"]

def is_writer_or_above(user: dict) -> bool:
    return ROLE_RANK.get(user.get("role"), 0) >= ROLE_RANK["writer"]

def can_see_mqj(user: dict) -> bool:
    # Admins/super_admin always; readers AND writers need an approved 迷情劑 access toggle.
    return is_admin(user) or user.get("mqj_access") == "approved"
