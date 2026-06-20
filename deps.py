from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from config import settings
from supabase import create_client, Client

bearer = HTTPBearer()

ROLE_RANK = {'super_admin': 4, 'admin': 3, 'writer': 2, 'reader': 1}

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
