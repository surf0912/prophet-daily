from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from deps import get_supabase_admin, get_current_user, require_admin, require_super_admin, invalidate_profile, record_audit
from supabase import Client

router = APIRouter()

class RoleRequest(BaseModel):
    role: str  # reader | writer | admin | super_admin

VALID_ROLES = {"reader", "writer", "admin", "super_admin"}

# (removed) The per-work permissions endpoints (/my, /novel/{id}, /grant, /revoke) were dead: the
# frontend modal was unreachable and reading access is governed by deps.check_novel_access, never the
# permissions table. The table itself is left in place (delete_user still cleans it) but is unused.

ROLE_RANK = {"reader": 0, "writer": 1, "admin": 2, "super_admin": 3}

@router.get("/server-stats", dependencies=[Depends(require_super_admin)])
def server_stats():
    """Live in-memory load snapshot for the SA 監看 panel (super_admin only)."""
    from monitor import snapshot
    return snapshot()

# Content tables worth backing up (everything the community created + account metadata).
# novel_views is deliberately excluded: it's high-volume view-log analytics, not creative content,
# and loading it all into memory could OOM the 512MB instance — the pg_dump backup still captures it.
_EXPORT_TABLES = [
    "profiles", "novels", "chapters", "comments", "comment_likes",
    "novel_favorites", "faqs", "feedback", "invite_tokens", "permissions",
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
    # last_seen_at / auto_publish are optional columns; fall back gracefully if not added yet.
    try:
        res = sb.table("profiles").select("id, username, nickname, avatar_url, role, mqj_access, banned, ban_until, created_at, last_seen_at, auto_publish, flag_note").order("created_at", desc=True).execute()
    except Exception:
        res = sb.table("profiles").select("id, username, nickname, avatar_url, role, mqj_access, banned, created_at").order("created_at", desc=True).execute()
    # An admin only sees members at the same rank or lower; only super_admin sees super_admin accounts.
    my_rank = ROLE_RANK.get(user.get("role"), 0)
    return [u for u in res.data if ROLE_RANK.get(u.get("role"), 0) <= my_rank]

@router.patch("/users/{user_id}/role")
def change_role(user_id: str, body: RoleRequest, user: dict = Depends(require_super_admin), sb: Client = Depends(get_supabase_admin)):
    if body.role not in VALID_ROLES:
        raise HTTPException(400, "Invalid role")
    res = sb.table("profiles").update({"role": body.role}).eq("id", user_id).execute()
    if not res.data:
        raise HTTPException(404, "User not found")
    invalidate_profile(user_id)
    record_audit(sb, user, "change_role", "user", user_id, f"role={body.role}")
    return res.data[0]

# ── Reset a member's 通關密語 (super_admin only) ──────────────
# Accounts use fake internal emails, so Supabase's email reset can't work — an admin sets
# a new password here, then tells the member privately.
class PasswordBody(BaseModel):
    password: str

@router.patch("/users/{user_id}/password")
def reset_password(user_id: str, body: PasswordBody, user: dict = Depends(require_super_admin), sb: Client = Depends(get_supabase_admin)):
    pw = (body.password or "").strip()
    if len(pw) < 8:
        raise HTTPException(400, "通關密語至少 8 字")
    try:
        sb.auth.admin.update_user_by_id(user_id, {"password": pw})
    except Exception as e:
        raise HTTPException(500, f"重設失敗：{e}")
    record_audit(sb, user, "reset_password", "user", user_id)
    return {"message": "ok"}

# ── Ban / delete accounts (super_admin only) ───────────────
class BanBody(BaseModel):
    banned: bool

@router.patch("/users/{user_id}/ban")
def set_banned(user_id: str, body: BanBody, user: dict = Depends(require_super_admin), sb: Client = Depends(get_supabase_admin)):
    # Permanent ban / full unban — owner (super_admin) only. ban_until is always cleared: a permanent
    # ban has no expiry, and unbanning must also drop any leftover temp-ban window.
    if user_id == user["id"]:
        raise HTTPException(400, "不能封禁自己")
    res = sb.table("profiles").update({"banned": body.banned, "ban_until": None}).eq("id", user_id).execute()
    if not res.data:
        raise HTTPException(404, "User not found")
    invalidate_profile(user_id)   # ban/unban takes effect immediately
    record_audit(sb, user, "ban" if body.banned else "unban", "user", user_id)
    return res.data[0]

@router.post("/users/{user_id}/temp-ban")
def temp_ban(user_id: str, body: BanBody, user: dict = Depends(require_admin), sb: Client = Depends(get_supabase_admin)):
    # 72h temporary ban — available to admins (and super_admin). Auto-lifts once ban_until passes
    # (enforced lazily in deps.get_current_user / signin). Admins may only act on a strictly lower
    # rank, and may NOT release a permanent ban (that stays the owner's call via /ban).
    if user_id == user["id"]:
        raise HTTPException(400, "不能封禁自己")
    target = sb.table("profiles").select("role, banned, ban_until").eq("id", user_id).single().execute().data
    if not target:
        raise HTTPException(404, "User not found")
    if ROLE_RANK.get(target.get("role"), 0) >= ROLE_RANK.get(user.get("role"), 0):
        raise HTTPException(403, "只能對權限較低的帳號操作")
    from datetime import datetime, timezone, timedelta
    if body.banned:
        until = (datetime.now(timezone.utc) + timedelta(hours=72)).isoformat()
        sb.table("profiles").update({"banned": True, "ban_until": until}).eq("id", user_id).execute()
        invalidate_profile(user_id)
        record_audit(sb, user, "temp_ban", "user", user_id, "72h")
        return {"banned": True, "ban_until": until}
    if target.get("banned") and not target.get("ban_until"):
        raise HTTPException(403, "永久封禁需由擁有者解除")
    sb.table("profiles").update({"banned": False, "ban_until": None}).eq("id", user_id).execute()
    invalidate_profile(user_id)
    record_audit(sb, user, "temp_unban", "user", user_id)
    return {"banned": False, "ban_until": None}

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
        lambda: sb.table("novel_favorites").delete().eq("user_id", user_id).execute(),
        lambda: sb.table("novel_views").delete().eq("user_id", user_id).execute(),
        lambda: sb.table("custom_char_tags").delete().eq("user_id", user_id).execute(),
        lambda: sb.table("custom_characters").delete().eq("user_id", user_id).execute(),
        lambda: sb.table("invite_tokens").update({"used_by": None}).eq("used_by", user_id).execute(),
        lambda: sb.table("invite_tokens").update({"created_by": actor}).eq("created_by", user_id).execute(),
        lambda: sb.table("novels").update({"created_by": actor}).eq("created_by", user_id).execute(),
        lambda: sb.table("chapters").update({"created_by": actor}).eq("created_by", user_id).execute(),
    ):
        try:
            op()
        except Exception:
            pass
    # Remove the deleted user from every work's co-owner array (read-modify-write — the REST API
    # can't edit individual array elements), so no work keeps a dangling deleted-user UUID.
    try:
        for nv in (sb.table("novels").select("id, owners").contains("owners", [user_id]).execute().data or []):
            sb.table("novels").update({"owners": [o for o in (nv.get("owners") or []) if o != user_id]}).eq("id", nv["id"]).execute()
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
    record_audit(sb, user, "delete_user", "user", user_id)
    return {"message": "deleted"}

# ── 迷情劑 access gate ──────────────────────────────────────
@router.post("/me/request-mqj")
def request_mqj(user: dict = Depends(get_current_user), sb: Client = Depends(get_supabase_admin)):
    # A reader asks for 迷情劑 access; admin approves later. No-op if already approved.
    if user.get("mqj_access") != "approved":
        sb.table("profiles").update({"mqj_access": "pending"}).eq("id", user["id"]).execute()
        invalidate_profile(user["id"])
    return {"mqj_access": "approved" if user.get("mqj_access") == "approved" else "pending"}

# ── 自動審核（auto-publish）：admin grants a writer review-free publishing ──
class AutoPublishBody(BaseModel):
    auto_publish: bool

@router.patch("/users/{user_id}/auto-publish")
def set_auto_publish(user_id: str, body: AutoPublishBody, user: dict = Depends(require_admin), sb: Client = Depends(get_supabase_admin)):
    res = sb.table("profiles").update({"auto_publish": body.auto_publish}).eq("id", user_id).execute()
    if not res.data:
        raise HTTPException(404, "User not found")
    invalidate_profile(user_id)   # takes effect on the writer's next upload immediately
    record_audit(sb, user, "auto_publish", "user", user_id, f"on={body.auto_publish}")
    return res.data[0]

class MqjBody(BaseModel):
    access: str  # 'none' | 'pending' | 'approved' | 'rejected'

@router.patch("/users/{user_id}/mqj")
def set_mqj(user_id: str, body: MqjBody, user: dict = Depends(require_admin), sb: Client = Depends(get_supabase_admin)):
    if body.access not in ("none", "pending", "approved", "rejected"):
        raise HTTPException(400, "Invalid access value")
    res = sb.table("profiles").update({"mqj_access": body.access}).eq("id", user_id).execute()
    if not res.data:
        raise HTTPException(404, "User not found")
    invalidate_profile(user_id)   # 迷情劑 approval/revoke takes effect immediately
    record_audit(sb, user, "mqj", "user", user_id, f"access={body.access}")
    return res.data[0]

# ── Admin action audit log (super_admin only) ──────────────
@router.get("/audit-log")
def get_audit_log(user: dict = Depends(require_super_admin), sb: Client = Depends(get_supabase_admin)):
    # Most recent admin actions (approve / ban / role / delete / lock / password / mqj / invite).
    try:
        return (sb.table("audit_log").select("*").order("created_at", desc=True).limit(200).execute().data or [])
    except Exception:
        return []

@router.patch("/users/{user_id}/clear-flag")
def clear_flag(user_id: str, user: dict = Depends(require_super_admin), sb: Client = Depends(get_supabase_admin)):
    # Dismiss a 疑似回鍋 flag after the super_admin has reviewed it.
    sb.table("profiles").update({"flag_note": None}).eq("id", user_id).execute()
    invalidate_profile(user_id)
    record_audit(sb, user, "clear_flag", "user", user_id)
    return {"ok": True}
