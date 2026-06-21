from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from deps import get_supabase_admin, get_current_user, require_admin, require_super_admin, invalidate_profile
from supabase import Client

router = APIRouter()

class GrantRequest(BaseModel):
    user_id: str
    novel_id: str

class RoleRequest(BaseModel):
    role: str  # reader | writer | admin | super_admin

VALID_ROLES = {"reader", "writer", "admin", "super_admin"}

@router.get("/my")
def my_permissions(user: dict = Depends(get_current_user), sb: Client = Depends(get_supabase_admin)):
    res = (
        sb.table("permissions")
        .select("*, novels(id, title, author, cover_url)")
        .eq("user_id", user["id"])
        .execute()
    )
    return res.data

@router.get("/novel/{novel_id}", dependencies=[Depends(require_admin)])
def novel_permissions(novel_id: str, sb: Client = Depends(get_supabase_admin)):
    res = (
        sb.table("permissions")
        .select("*, profiles(username, avatar_url)")
        .eq("novel_id", novel_id)
        .execute()
    )
    return res.data

@router.post("/grant", dependencies=[Depends(require_admin)])
def grant(body: GrantRequest, user: dict = Depends(require_admin), sb: Client = Depends(get_supabase_admin)):
    res = sb.table("permissions").upsert({
        "user_id": body.user_id,
        "novel_id": body.novel_id,
        "granted_by": user["id"],
    }).execute()
    return res.data[0]

@router.delete("/revoke")
def revoke(body: GrantRequest, user: dict = Depends(require_admin), sb: Client = Depends(get_supabase_admin)):
    sb.table("permissions").delete().eq("user_id", body.user_id).eq("novel_id", body.novel_id).execute()
    return {"message": "Revoked"}

ROLE_RANK = {"reader": 0, "writer": 1, "admin": 2, "super_admin": 3}

@router.get("/server-stats", dependencies=[Depends(require_super_admin)])
def server_stats():
    """Live in-memory load snapshot for the SA 監看 panel (super_admin only)."""
    from monitor import snapshot
    return snapshot()

# Content tables worth backing up (everything the community created + account metadata).
_EXPORT_TABLES = [
    "profiles", "novels", "chapters", "comments", "comment_likes",
    "novel_favorites", "novel_views", "faqs", "feedback", "invite_tokens", "permissions",
]

@router.get("/export", dependencies=[Depends(require_super_admin)])
def export_all(sb: Client = Depends(get_supabase_admin)):
    """One-click content backup (super_admin only). Returns every content table as JSON. Covers the
    creative content + account metadata — NOT auth passwords (those live in Supabase auth.users; use
    the pg_dump GitHub Action for a full disaster-recovery backup)."""
    from datetime import datetime, timezone
    def fetch_all(table):
        rows, start, page = [], 0, 1000
        while True:
            chunk = sb.table(table).select("*").range(start, start + page - 1).execute().data or []
            rows.extend(chunk)
            if len(chunk) < page:
                return rows
            start += page
    out = {"_exported_at": datetime.now(timezone.utc).isoformat(), "_version": "1", "tables": {}}
    for t in _EXPORT_TABLES:
        try:
            out["tables"][t] = fetch_all(t)
        except Exception as e:
            out["tables"][t] = {"_error": str(e)}
    return out

@router.get("/users")
def list_users(user: dict = Depends(require_admin), sb: Client = Depends(get_supabase_admin)):
    # last_seen_at powers the 不活躍用戶 report; fall back gracefully if the column isn't added yet.
    try:
        res = sb.table("profiles").select("id, username, nickname, avatar_url, role, mqj_access, banned, created_at, last_seen_at").order("created_at", desc=True).execute()
    except Exception:
        res = sb.table("profiles").select("id, username, nickname, avatar_url, role, mqj_access, banned, created_at").order("created_at", desc=True).execute()
    # An admin only sees members at the same rank or lower; only super_admin sees super_admin accounts.
    my_rank = ROLE_RANK.get(user.get("role"), 0)
    return [u for u in res.data if ROLE_RANK.get(u.get("role"), 0) <= my_rank]

@router.patch("/users/{user_id}/role", dependencies=[Depends(require_super_admin)])
def change_role(user_id: str, body: RoleRequest, sb: Client = Depends(get_supabase_admin)):
    if body.role not in VALID_ROLES:
        raise HTTPException(400, "Invalid role")
    res = sb.table("profiles").update({"role": body.role}).eq("id", user_id).execute()
    if not res.data:
        raise HTTPException(404, "User not found")
    invalidate_profile(user_id)
    return res.data[0]

# ── Reset a member's 通關密語 (super_admin only) ──────────────
# Accounts use fake internal emails, so Supabase's email reset can't work — an admin sets
# a new password here, then tells the member privately.
class PasswordBody(BaseModel):
    password: str

@router.patch("/users/{user_id}/password", dependencies=[Depends(require_super_admin)])
def reset_password(user_id: str, body: PasswordBody, sb: Client = Depends(get_supabase_admin)):
    pw = (body.password or "").strip()
    if len(pw) < 6:
        raise HTTPException(400, "通關密語至少 6 字")
    try:
        sb.auth.admin.update_user_by_id(user_id, {"password": pw})
    except Exception as e:
        raise HTTPException(500, f"重設失敗：{e}")
    return {"message": "ok"}

# ── Ban / delete accounts (super_admin only) ───────────────
class BanBody(BaseModel):
    banned: bool

@router.patch("/users/{user_id}/ban")
def set_banned(user_id: str, body: BanBody, user: dict = Depends(require_super_admin), sb: Client = Depends(get_supabase_admin)):
    if user_id == user["id"]:
        raise HTTPException(400, "不能封禁自己")
    res = sb.table("profiles").update({"banned": body.banned}).eq("id", user_id).execute()
    if not res.data:
        raise HTTPException(404, "User not found")
    invalidate_profile(user_id)   # ban/unban takes effect immediately
    return res.data[0]

@router.delete("/users/{user_id}")
def delete_user(user_id: str, user: dict = Depends(require_super_admin), sb: Client = Depends(get_supabase_admin)):
    if user_id == user["id"]:
        raise HTTPException(400, "不能刪除自己")
    actor = user["id"]
    # Clear/reassign every row that references this user so foreign keys don't block the
    # delete. Authored works are kept (created_by reassigned to the acting super_admin).
    for op in (
        lambda: sb.table("comment_likes").delete().eq("user_id", user_id).execute(),
        lambda: sb.table("comments").delete().eq("user_id", user_id).execute(),
        lambda: sb.table("permissions").delete().eq("user_id", user_id).execute(),
        lambda: sb.table("invite_tokens").update({"used_by": None}).eq("used_by", user_id).execute(),
        lambda: sb.table("invite_tokens").update({"created_by": actor}).eq("created_by", user_id).execute(),
        lambda: sb.table("novels").update({"created_by": actor}).eq("created_by", user_id).execute(),
        lambda: sb.table("chapters").update({"created_by": actor}).eq("created_by", user_id).execute(),
    ):
        try:
            op()
        except Exception:
            pass
    # Now remove the profile + auth user; surface the real DB error if something still blocks.
    err = None
    try:
        sb.table("profiles").delete().eq("id", user_id).execute()
    except Exception as e:
        err = f"profile: {e}"
    try:
        sb.auth.admin.delete_user(user_id)
    except Exception as e:
        err = (err + " | " if err else "") + f"auth: {e}"
    if err:
        raise HTTPException(500, f"刪除未完成：{err}")
    invalidate_profile(user_id)
    return {"message": "deleted"}

# ── 迷情劑 access gate ──────────────────────────────────────
@router.post("/me/request-mqj")
def request_mqj(user: dict = Depends(get_current_user), sb: Client = Depends(get_supabase_admin)):
    # A reader asks for 迷情劑 access; admin approves later. No-op if already approved.
    if user.get("mqj_access") != "approved":
        sb.table("profiles").update({"mqj_access": "pending"}).eq("id", user["id"]).execute()
        invalidate_profile(user["id"])
    return {"mqj_access": "approved" if user.get("mqj_access") == "approved" else "pending"}

class MqjBody(BaseModel):
    access: str  # 'none' | 'pending' | 'approved' | 'rejected'

@router.patch("/users/{user_id}/mqj", dependencies=[Depends(require_admin)])
def set_mqj(user_id: str, body: MqjBody, sb: Client = Depends(get_supabase_admin)):
    if body.access not in ("none", "pending", "approved", "rejected"):
        raise HTTPException(400, "Invalid access value")
    res = sb.table("profiles").update({"mqj_access": body.access}).eq("id", user_id).execute()
    if not res.data:
        raise HTTPException(404, "User not found")
    invalidate_profile(user_id)   # 迷情劑 approval/revoke takes effect immediately
    return res.data[0]
