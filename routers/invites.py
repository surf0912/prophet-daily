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
    rows = sb.table("invite_tokens").select("*").eq("token", token).limit(1).execute().data
    inv = rows[0] if rows else None
    if not inv:
        raise HTTPException(410, "此邀請連結已使用")   # not found = revoked (hard-deleted) or bad token → "used up", not "invalid". .single() raises on no row (→500), so use limit(1).
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
    from datetime import datetime, timezone
    # 1) Read once for clear error messages. The real gate is the atomic claim in step 3.
    rows = sb_admin.table("invite_tokens").select("*").eq("token", body.token).limit(1).execute().data
    inv = rows[0] if rows else None
    if not inv:
        raise HTTPException(410, "此邀請連結已使用")   # not found = revoked (hard-deleted) or bad token. limit(1) (not .single()) so no row → no 500.
    if inv["used_at"] is not None:
        raise HTTPException(410, "此邀請連結已使用")
    expires = datetime.fromisoformat(inv["expires_at"].replace("Z", "+00:00"))
    if datetime.now(timezone.utc) > expires:
        raise HTTPException(410, "此邀請連結已過期")

    # 2) Validate username + password BEFORE claiming so a malformed request never consumes the token.
    if not re.match(r'^[a-zA-Z0-9_]{2,20}$', body.username):
        raise HTTPException(400, "用戶名只能包含英文、數字、底線，長度 2-20 字元")
    if len(body.password or "") < 8:
        raise HTTPException(400, "通關密語至少 8 字")

    email = username_to_email(body.username)
    nickname = (body.nickname or body.username).strip()[:20] or body.username

    # 3) ATOMIC CLAIM: flip used_at only while it is still NULL (and not expired). Concurrent
    #    registrations race here and Postgres row-locks the UPDATE, so exactly one wins — one token
    #    can never mint two accounts.
    now_iso = datetime.now(timezone.utc).isoformat()
    claimed = (sb_admin.table("invite_tokens").update({"used_at": now_iso})
               .eq("token", body.token).is_("used_at", "null").gt("expires_at", now_iso)
               .execute().data)
    if not claimed:
        raise HTTPException(410, "此邀請連結已使用")   # another request claimed it first

    # 4) Create the account. On ANY failure, release the claim so the invite stays usable (no
    #    orphaned "account exists but token still consumed / token consumed but no account" states).
    try:
        auth_res = sb_admin.auth.admin.create_user({
            "email": email,
            "password": body.password,
            "email_confirm": True,
            "user_metadata": {"username": body.username, "role": inv["role"], "nickname": nickname},
        })
        if not auth_res.user:
            raise HTTPException(400, "註冊失敗，請稍後再試")
    except Exception as e:
        # Release only the claim made by THIS request. Matching used_at prevents a delayed
        # failure from clearing a token that was subsequently claimed by somebody else.
        (sb_admin.table("invite_tokens").update({"used_at": None, "used_by": None})
         .eq("token", body.token).eq("used_at", now_iso).is_("used_by", "null").execute())
        raise e if isinstance(e, HTTPException) else HTTPException(400, "註冊失敗，請稍後再試")

    new_user_id = auth_res.user.id
    # The DB trigger deliberately creates every profile as a reader: user_metadata is controlled
    # by the person signing up and must never grant authorization. Only this service-role path may
    # promote the new account to the role encoded in the already-claimed invite.
    try:
        profile = (sb_admin.table("profiles")
                   .update({"nickname": nickname, "role": inv["role"]})
                   .eq("id", new_user_id).execute().data)
        if not profile:
            raise RuntimeError("profile was not created")
        finalized = (sb_admin.table("invite_tokens").update({"used_by": new_user_id})
                     .eq("token", body.token).eq("used_at", now_iso).is_("used_by", "null")
                     .execute().data)
        if not finalized:
            raise RuntimeError("invite claim was lost")
    except Exception:
        # Auth and Postgres cannot share one transaction. Compensate on a partial failure so an
        # account is never left behind with an unfinalized invite (profile cascades with auth user).
        try:
            sb_admin.auth.admin.delete_user(new_user_id)
        finally:
            (sb_admin.table("invite_tokens").update({"used_at": None, "used_by": None})
             .eq("token", body.token).eq("used_at", now_iso).is_("used_by", "null").execute())
        raise HTTPException(500, "註冊未完成，邀請碼已保留，請重試")
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
