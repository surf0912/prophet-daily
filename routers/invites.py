from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional
from deps import get_supabase, get_supabase_admin, get_current_user, require_admin
from supabase import Client
import re

router = APIRouter()

INTERNAL_DOMAIN = "prophet-daily.internal"

def username_to_email(username: str) -> str:
    return f"{username.lower()}@{INTERNAL_DOMAIN}"

import secrets
# Short, unambiguous invite codes (no 0/O/1/I/l). ~8 chars from a 54-char set ≈ huge space.
_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789"
def _make_code(n: int = 8) -> str:
    return "".join(secrets.choice(_CODE_ALPHABET) for _ in range(n))

class InviteCreate(BaseModel):
    role: str = "reader"
    note: Optional[str] = None
    count: int = 1

class RegisterWithInvite(BaseModel):
    token: str
    username: str          # 巫師入學全名 (login id, English only)
    password: str          # 通關密語
    nickname: Optional[str] = None   # 巫師姓名 (display name, may be Chinese)

@router.post("/generate")
def generate_invite(
    body: InviteCreate,
    user: dict = Depends(require_admin),
    sb: Client = Depends(get_supabase_admin),
):
    # admin can only grant reader/writer; super_admin can also grant admin
    allowed = ["reader", "writer"]
    if user["role"] == "super_admin":
        allowed.append("admin")
    if body.role not in allowed:
        raise HTTPException(403, f"You cannot grant role '{body.role}'")

    from datetime import datetime, timezone, timedelta
    expires_at = (datetime.now(timezone.utc) + timedelta(days=3)).isoformat()
    # Bulk generation is super_admin-only; admins always get exactly one.
    count = max(1, min(20, body.count or 1)) if user["role"] == "super_admin" else 1
    tokens = []
    for _ in range(count):
        for attempt in range(6):                # short codes can collide → retry
            try:
                res = sb.table("invite_tokens").insert({
                    "token": _make_code(8),
                    "role": body.role,
                    "created_by": user["id"],
                    "expires_at": expires_at,
                }).execute()
                tokens.append(res.data[0]["token"])
                break
            except Exception:
                if attempt == 5:
                    raise HTTPException(500, "產生邀請失敗，請重試")
    return {"tokens": tokens, "token": tokens[0], "role": body.role}

@router.get("/validate/{token}")
def validate_invite(token: str, sb: Client = Depends(get_supabase_admin)):
    res = sb.table("invite_tokens").select("*").eq("token", token).single().execute()
    if not res.data:
        raise HTTPException(404, "邀請連結無效")
    inv = res.data
    if inv["used_at"] is not None:
        raise HTTPException(410, "此邀請連結已使用")
    # Check expiry
    from datetime import datetime, timezone
    expires = datetime.fromisoformat(inv["expires_at"].replace("Z", "+00:00"))
    if datetime.now(timezone.utc) > expires:
        raise HTTPException(410, "此邀請連結已過期")
    return {"valid": True, "role": inv["role"]}

@router.post("/register")
def register_with_invite(body: RegisterWithInvite, sb_admin: Client = Depends(get_supabase_admin)):
    # Validate token first
    res = sb_admin.table("invite_tokens").select("*").eq("token", body.token).single().execute()
    if not res.data:
        raise HTTPException(404, "邀請連結無效")
    inv = res.data
    if inv["used_at"] is not None:
        raise HTTPException(410, "此邀請連結已使用")
    from datetime import datetime, timezone
    expires = datetime.fromisoformat(inv["expires_at"].replace("Z", "+00:00"))
    if datetime.now(timezone.utc) > expires:
        raise HTTPException(410, "此邀請連結已過期")

    # Validate username format
    if not re.match(r'^[a-zA-Z0-9_]{2,20}$', body.username):
        raise HTTPException(400, "用戶名只能包含英文、數字、底線，長度 2-20 字元")

    email = username_to_email(body.username)
    nickname = (body.nickname or body.username).strip()[:20] or body.username

    # Create auth user with correct role in metadata
    auth_res = sb_admin.auth.admin.create_user({
        "email": email,
        "password": body.password,
        "email_confirm": True,
        "user_metadata": {"username": body.username, "role": inv["role"], "nickname": nickname},
    })
    if not auth_res.user:
        raise HTTPException(400, "註冊失敗，請稍後再試")

    new_user_id = auth_res.user.id
    # The profile row is created by a trigger from metadata; ensure nickname is set.
    sb_admin.table("profiles").update({"nickname": nickname}).eq("id", new_user_id).execute()

    # Mark token as used
    sb_admin.table("invite_tokens").update({
        "used_by": new_user_id,
        "used_at": datetime.now(timezone.utc).isoformat(),
    }).eq("token", body.token).execute()

    return {"message": "註冊成功，請使用你的帳號登入"}

@router.get("/list")
def list_invites(user: dict = Depends(require_admin), sb: Client = Depends(get_supabase_admin)):
    res = (
        sb.table("invite_tokens")
        .select("id, token, role, created_at, expires_at, used_at, profiles!invite_tokens_used_by_fkey(username)")
        .order("created_at", desc=True)
        .execute()
    )
    return res.data

@router.delete("/{invite_id}")
def revoke_invite(invite_id: str, user: dict = Depends(require_admin), sb: Client = Depends(get_supabase_admin)):
    sb.table("invite_tokens").delete().eq("id", invite_id).execute()
    return {"message": "Revoked"}
