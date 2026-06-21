from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from config import settings
from supabase import create_client, Client
import jwt

bearer = HTTPBearer()

ROLE_RANK = {'super_admin': 4, 'admin': 3, 'writer': 2, 'reader': 1}

def _verify_jwt_local(token: str):
    """Validate a Supabase access token locally (HS256) so we can skip the network round-trip to
    the Supabase Auth server on every authenticated request. Returns the user id (sub claim), or
    None when local verification isn't possible — wrong/missing secret, expired token, or a project
    that signs with asymmetric keys — so the caller can fall back to sb.auth.get_user(). Signature
    and expiry are still enforced, so a None result is always either "let the slow path decide" or
    a genuinely bad token (which the slow path will also reject)."""
    secret = getattr(settings, "jwt_secret", "") or ""
    if not secret:
        return None
    try:
        payload = jwt.decode(token, secret, algorithms=["HS256"], options={"verify_aud": False})
        return payload.get("sub")
    except Exception:
        return None

def get_supabase() -> Client:
    return create_client(settings.supabase_url, settings.supabase_anon_key)

def get_supabase_admin() -> Client:
    return create_client(settings.supabase_url, settings.supabase_service_key)

def get_current_user(
    creds: HTTPAuthorizationCredentials = Depends(bearer),
    sb: Client = Depends(get_supabase),
    sb_admin: Client = Depends(get_supabase_admin),
):
    token = creds.credentials
    # Fast path: verify the JWT locally (no network). Falls back to the Auth server only when
    # local verification can't decide (e.g. JWT_SECRET not set to the Supabase secret yet).
    user_id = _verify_jwt_local(token)
    used_local = user_id is not None
    if not user_id:
        try:
            auth_user = sb.auth.get_user(token)
            user_id = auth_user.user.id
        except Exception:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")

    result = sb_admin.table("profiles").select("*").eq("id", user_id).single().execute()
    if not result.data:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")
    if result.data.get("banned"):
        # 401 so the client drops the session and returns to the login screen.
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="此帳號已被封禁")
    try:
        from monitor import record_user, record_auth
        record_user(user_id)
        record_auth(used_local)
    except Exception:
        pass
    return result.data

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
