from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from deps import get_supabase_admin, get_current_user, require_admin, require_super_admin
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

@router.get("/users")
def list_users(user: dict = Depends(require_admin), sb: Client = Depends(get_supabase_admin)):
    res = sb.table("profiles").select("id, username, nickname, avatar_url, role, mqj_access, created_at").order("created_at", desc=True).execute()
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
    return res.data[0]

# ── 迷情劑 access gate ──────────────────────────────────────
@router.post("/me/request-mqj")
def request_mqj(user: dict = Depends(get_current_user), sb: Client = Depends(get_supabase_admin)):
    # A reader asks for 迷情劑 access; admin approves later. No-op if already approved.
    if user.get("mqj_access") != "approved":
        sb.table("profiles").update({"mqj_access": "pending"}).eq("id", user["id"]).execute()
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
    return res.data[0]
