from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional
from deps import get_supabase_admin, get_current_user, require_admin, require_writer, is_admin, can_see_mqj
from supabase import Client

router = APIRouter()

@router.get("/novel/{novel_id}")
def list_chapters(
    novel_id: str,
    user: dict = Depends(get_current_user),
    sb: Client = Depends(get_supabase_admin),
):
    _check_novel_access(novel_id, user, sb)
    res = (
        sb.table("chapters")
        .select("id, chapter_num, title, created_at")
        .eq("novel_id", novel_id)
        .order("chapter_num")
        .execute()
    )
    return res.data

@router.get("/{chapter_id}")
def get_chapter(
    chapter_id: str,
    user: dict = Depends(get_current_user),
    sb: Client = Depends(get_supabase_admin),
):
    rows = sb.table("chapters").select("*").eq("id", chapter_id).limit(1).execute().data
    if not rows:
        raise HTTPException(404, "Chapter not found")   # .single() raises on a missing id (→500); limit(1) → clean 404
    _check_novel_access(rows[0]["novel_id"], user, sb)
    return rows[0]

class ChapterTextBody(BaseModel):
    chapter_num: int
    title: Optional[str] = None
    content: str

def _require_owner_or_admin(novel_id: str, user: dict, sb: Client):
    rows = sb.table("novels").select("owners").eq("id", novel_id).limit(1).execute().data
    if not rows:
        raise HTTPException(404, "Novel not found")
    if is_admin(user) or user["id"] in (rows[0].get("owners") or []):
        return
    raise HTTPException(403, "只能管理自己的作品")

@router.post("/novel/{novel_id}/text")
def create_chapter_text(
    novel_id: str,
    body: ChapterTextBody,
    user: dict = Depends(require_writer),
    sb_admin: Client = Depends(get_supabase_admin),
):
    _require_owner_or_admin(novel_id, user, sb_admin)
    res = sb_admin.table("chapters").insert({
        "novel_id": novel_id,
        "chapter_num": body.chapter_num,
        "title": body.title,
        "content": body.content.strip(),
        "created_by": user["id"],
    }).execute()
    _touch_novel(novel_id, sb_admin)
    return res.data[0]

@router.put("/{chapter_id}/text")
def update_chapter_text(
    chapter_id: str,
    body: ChapterTextBody,
    user: dict = Depends(require_writer),
    sb_admin: Client = Depends(get_supabase_admin),
):
    rows = sb_admin.table("chapters").select("novel_id").eq("id", chapter_id).limit(1).execute().data
    if not rows:
        raise HTTPException(404, "Chapter not found")
    _require_owner_or_admin(rows[0]["novel_id"], user, sb_admin)
    res = sb_admin.table("chapters").update({
        "chapter_num": body.chapter_num,
        "title": body.title,
        "content": body.content.strip(),
    }).eq("id", chapter_id).execute()
    if not res.data:
        raise HTTPException(404, "Chapter not found")
    return res.data[0]

@router.delete("/{chapter_id}", dependencies=[Depends(require_admin)])
def delete_chapter(chapter_id: str, sb: Client = Depends(get_supabase_admin)):
    sb.table("chapters").delete().eq("id", chapter_id).execute()
    return {"message": "Deleted"}

def _touch_novel(novel_id: str, sb_admin: Client):
    # bump the work's "latest update" timestamp whenever a chapter is added
    sb_admin.table("novels").update({"updated_at": "now()"}).eq("id", novel_id).execute()

def _check_novel_access(novel_id: str, user: dict, sb: Client):
    # Approved works → any logged-in user. Pending → admins and the creator only.
    rows = sb.table("novels").select("status, owners, category").eq("id", novel_id).limit(1).execute().data
    nv = rows[0] if rows else None
    if not nv:
        raise HTTPException(404, "Novel not found")
    if nv.get("category") == "迷情劑" and not can_see_mqj(user):
        raise HTTPException(403, "迷情劑分類需管理員開放才能閱讀")
    if nv.get("status") == "approved":
        return
    if is_admin(user) or user["id"] in (nv.get("owners") or []):
        return
    raise HTTPException(403, "This work is awaiting approval")
