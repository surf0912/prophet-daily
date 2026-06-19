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

@router.get("/users", dependencies=[Depends(require_admin)])
def list_users(sb: Client = Depends(get_supabase_admin)):
    res = sb.table("profiles").select("id, username, role, created_at").order("created_at", desc=True).execute()
    return res.data

@router.patch("/users/{user_id}/role", dependencies=[Depends(require_super_admin)])
def change_role(user_id: str, body: RoleRequest, sb: Client = Depends(get_supabase_admin)):
    if body.role not in VALID_ROLES:
        raise HTTPException(400, "Invalid role")
    res = sb.table("profiles").update({"role": body.role}).eq("id", user_id).execute()
    if not res.data:
        raise HTTPException(404, "User not found")
    return res.data[0]
