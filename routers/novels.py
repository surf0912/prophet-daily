from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional, List
from deps import get_supabase_admin, get_current_user, require_admin, require_writer, is_admin
from supabase import Client

router = APIRouter()

class NovelCreate(BaseModel):
    title: str
    author: Optional[str] = None
    description: Optional[str] = None
    cover_url: Optional[str] = None
    kind: str = "novel"            # 'novel' | 'forum'
    category: Optional[str] = None       # 迷情劑 | 吐真劑 | 儲思盆
    characters: List[str] = []           # subset of sean/silas/eli/adrian
    published_at: Optional[str] = None   # custom date (ISO) for back-dating past works

class NovelUpdate(BaseModel):
    title: Optional[str] = None
    author: Optional[str] = None
    description: Optional[str] = None
    cover_url: Optional[str] = None
    category: Optional[str] = None
    characters: Optional[List[str]] = None

class ForumPostCreate(BaseModel):
    title: str
    content: str
    author: Optional[str] = None
    category: Optional[str] = None
    characters: List[str] = []
    published_at: Optional[str] = None   # custom date (ISO) for back-dating past posts

@router.get("/")
def list_novels(
    kind: Optional[str] = None,
    user: dict = Depends(get_current_user),
    sb: Client = Depends(get_supabase_admin),
):
    # Everyone sees all APPROVED works (no per-user permission gating anymore).
    # Admins additionally see pending works so they can review.
    q = sb.table("novels").select("*")
    if kind:
        q = q.eq("kind", kind)
    if not is_admin(user):
        q = q.eq("status", "approved")
    res = q.order("created_at", desc=True).execute()
    return res.data

@router.get("/pending", dependencies=[Depends(require_admin)])
def list_pending(sb: Client = Depends(get_supabase_admin)):
    res = (
        sb.table("novels").select("*")
        .eq("status", "pending")
        .order("created_at", desc=True)
        .execute()
    )
    return res.data

@router.get("/{novel_id}")
def get_novel(novel_id: str, user: dict = Depends(get_current_user), sb: Client = Depends(get_supabase_admin)):
    res = sb.table("novels").select("*").eq("id", novel_id).single().execute()
    if not res.data:
        raise HTTPException(404, "Novel not found")
    _check_novel_access(res.data, user)
    return res.data

@router.post("/", dependencies=[Depends(require_writer)])
def create_novel(body: NovelCreate, user: dict = Depends(require_writer), sb: Client = Depends(get_supabase_admin)):
    # Admin/super_admin uploads are public immediately; writers' uploads await approval.
    status = "approved" if is_admin(user) else "pending"
    data = body.dict()
    published_at = data.pop("published_at", None)
    record = {**data, "created_by": user["id"], "status": status}
    if published_at:
        record["created_at"] = published_at
        record["updated_at"] = published_at
    res = sb.table("novels").insert(record).execute()
    return res.data[0]

@router.post("/forum", dependencies=[Depends(require_writer)])
def create_forum_post(body: ForumPostCreate, user: dict = Depends(require_writer), sb: Client = Depends(get_supabase_admin)):
    # A forum post is a kind='forum' novel whose single chapter holds the body text.
    status = "approved" if is_admin(user) else "pending"
    record = {
        "title": body.title,
        "author": body.author,
        "kind": "forum",
        "status": status,
        "category": body.category,
        "characters": body.characters,
        "created_by": user["id"],
    }
    if body.published_at:
        record["created_at"] = body.published_at
        record["updated_at"] = body.published_at
    novel = sb.table("novels").insert(record).execute().data[0]
    sb.table("chapters").insert({
        "novel_id": novel["id"],
        "chapter_num": 1,
        "title": body.title,
        "content": body.content.strip(),
        "created_by": user["id"],
    }).execute()
    return novel

@router.patch("/{novel_id}/approve", dependencies=[Depends(require_admin)])
def approve_novel(novel_id: str, sb: Client = Depends(get_supabase_admin)):
    res = sb.table("novels").update({"status": "approved"}).eq("id", novel_id).execute()
    if not res.data:
        raise HTTPException(404, "Novel not found")
    return res.data[0]

class TransferBody(BaseModel):
    user_id: str

@router.patch("/{novel_id}/transfer", dependencies=[Depends(require_admin)])
def transfer_novel(novel_id: str, body: TransferBody, sb: Client = Depends(get_supabase_admin)):
    target = sb.table("profiles").select("id").eq("id", body.user_id).single().execute()
    if not target.data:
        raise HTTPException(404, "Target user not found")
    sb.table("novels").update({"created_by": body.user_id}).eq("id", novel_id).execute()
    sb.table("chapters").update({"created_by": body.user_id}).eq("novel_id", novel_id).execute()
    return {"message": "transferred"}

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

def _check_novel_access(novel: dict, user: dict):
    # Approved works are visible to every logged-in user.
    # Pending works are visible only to admins and the creator (for preview/review).
    if novel.get("status") == "approved":
        return
    if is_admin(user) or novel.get("created_by") == user["id"]:
        return
    raise HTTPException(403, "This work is awaiting approval")
