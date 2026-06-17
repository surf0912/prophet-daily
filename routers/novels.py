from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional
from deps import get_supabase_admin, get_current_user, require_admin, is_admin
from supabase import Client

router = APIRouter()

class NovelCreate(BaseModel):
    title: str
    author: Optional[str] = None
    description: Optional[str] = None
    cover_url: Optional[str] = None

class NovelUpdate(BaseModel):
    title: Optional[str] = None
    author: Optional[str] = None
    description: Optional[str] = None
    cover_url: Optional[str] = None

@router.get("/")
def list_novels(user: dict = Depends(get_current_user), sb: Client = Depends(get_supabase_admin)):
    if is_admin(user):
        res = sb.table("novels").select("*").order("created_at", desc=True).execute()
    else:
        # Only novels the reader has permission for
        perm = sb.table("permissions").select("novel_id").eq("user_id", user["id"]).execute()
        novel_ids = [p["novel_id"] for p in perm.data]
        if not novel_ids:
            return []
        res = sb.table("novels").select("*").in_("id", novel_ids).order("created_at", desc=True).execute()
    return res.data

@router.get("/{novel_id}")
def get_novel(novel_id: str, user: dict = Depends(get_current_user), sb: Client = Depends(get_supabase_admin)):
    _check_novel_access(novel_id, user, sb)
    res = sb.table("novels").select("*").eq("id", novel_id).single().execute()
    return res.data

@router.post("/", dependencies=[Depends(require_admin)])
def create_novel(body: NovelCreate, user: dict = Depends(require_admin), sb: Client = Depends(get_supabase_admin)):
    res = sb.table("novels").insert({**body.dict(), "created_by": user["id"]}).execute()
    return res.data[0]

@router.patch("/{novel_id}", dependencies=[Depends(require_admin)])
def update_novel(novel_id: str, body: NovelUpdate, sb: Client = Depends(get_supabase_admin)):
    updates = {k: v for k, v in body.dict().items() if v is not None}
    if not updates:
        raise HTTPException(400, "No fields to update")
    updates["updated_at"] = "now()"
    res = sb.table("novels").update(updates).eq("id", novel_id).execute()
    return res.data[0]

@router.delete("/{novel_id}", dependencies=[Depends(require_admin)])
def delete_novel(novel_id: str, sb: Client = Depends(get_supabase_admin)):
    sb.table("novels").delete().eq("id", novel_id).execute()
    return {"message": "Deleted"}

def _check_novel_access(novel_id: str, user: dict, sb: Client):
    if is_admin(user):
        return
    perm = sb.table("permissions").select("id").eq("user_id", user["id"]).eq("novel_id", novel_id).execute()
    if not perm.data:
        raise HTTPException(403, "No access to this novel")
