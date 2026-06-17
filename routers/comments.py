from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional
from deps import get_supabase_admin, get_current_user, require_admin, is_admin
from supabase import Client

router = APIRouter()

class CommentCreate(BaseModel):
    chapter_id: str
    content: str
    parent_id: Optional[str] = None

@router.get("/chapter/{chapter_id}")
def list_comments(
    chapter_id: str,
    user: dict = Depends(get_current_user),
    sb: Client = Depends(get_supabase_admin),
):
    # Verify user has access to the novel containing this chapter
    ch = sb.table("chapters").select("novel_id").eq("id", chapter_id).single().execute()
    if not ch.data:
        raise HTTPException(404, "Chapter not found")
    _check_novel_access(ch.data["novel_id"], user, sb)

    res = (
        sb.table("comments")
        .select("*, profiles(username, avatar_url)")
        .eq("chapter_id", chapter_id)
        .order("created_at")
        .execute()
    )
    return res.data

@router.post("/")
def create_comment(
    body: CommentCreate,
    user: dict = Depends(get_current_user),
    sb: Client = Depends(get_supabase_admin),
):
    ch = sb.table("chapters").select("novel_id").eq("id", body.chapter_id).single().execute()
    if not ch.data:
        raise HTTPException(404, "Chapter not found")
    _check_novel_access(ch.data["novel_id"], user, sb)

    res = sb.table("comments").insert({
        "chapter_id": body.chapter_id,
        "user_id": user["id"],
        "content": body.content,
        "parent_id": body.parent_id,
    }).execute()
    return res.data[0]

@router.delete("/{comment_id}")
def delete_comment(
    comment_id: str,
    user: dict = Depends(get_current_user),
    sb: Client = Depends(get_supabase_admin),
):
    res = sb.table("comments").select("user_id").eq("id", comment_id).single().execute()
    if not res.data:
        raise HTTPException(404, "Comment not found")
    if res.data["user_id"] != user["id"] and not is_admin(user):
        raise HTTPException(403, "Cannot delete others' comments")
    sb.table("comments").delete().eq("id", comment_id).execute()
    return {"message": "Deleted"}

def _check_novel_access(novel_id: str, user: dict, sb: Client):
    if is_admin(user):
        return
    perm = sb.table("permissions").select("id").eq("user_id", user["id"]).eq("novel_id", novel_id).execute()
    if not perm.data:
        raise HTTPException(403, "No access to this novel")
