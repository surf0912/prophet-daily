from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional, List
from deps import get_supabase_admin, get_current_user, require_admin, require_writer, is_admin, can_see_mqj
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
    published_at: Optional[str] = None   # edit the 發佈日期 (maps to created_at)

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
    mine: bool = False,
    user: dict = Depends(get_current_user),
    sb: Client = Depends(get_supabase_admin),
):
    # Everyone sees all APPROVED works (no per-user permission gating anymore).
    # Admins additionally see pending works so they can review.
    q = sb.table("novels").select("*")
    if kind:
        q = q.eq("kind", kind)
    # mine=true → only the caller's own works (any status), for 作品管理.
    if mine:
        q = q.contains("owners", [user["id"]])
        return q.order("created_at", desc=True).execute().data
    if not is_admin(user):
        q = q.eq("status", "approved")
    res = q.order("created_at", desc=True).execute()
    data = res.data
    # Readers without 迷情劑 access don't see 迷情劑 works.
    if not can_see_mqj(user):
        data = [n for n in data if n.get("category") != "迷情劑"]
    return data

@router.get("/pending", dependencies=[Depends(require_admin)])
def list_pending(sb: Client = Depends(get_supabase_admin)):
    res = (
        sb.table("novels").select("*")
        .eq("status", "pending")
        .order("created_at", desc=True)
        .execute()
    )
    return res.data

# Posts/works the caller has liked at least one comment in (for the "我讚過的" view).
# Declared before /{novel_id} so the static path wins.
@router.get("/my-liked")
def my_liked(user: dict = Depends(get_current_user), sb: Client = Depends(get_supabase_admin)):
    rows = sb.table("comment_likes").select("novel_id").eq("user_id", user["id"]).execute().data or []
    if not rows:
        return []
    counts: dict = {}
    for r in rows:
        counts[r["novel_id"]] = counts.get(r["novel_id"], 0) + 1
    novels = sb.table("novels").select("*").in_("id", list(counts.keys())).execute().data or []
    out = []
    for n in novels:
        if n.get("status") != "approved" and not is_admin(user):
            continue  # don't surface works that are no longer public
        n["liked_count"] = counts.get(n["id"], 0)
        out.append(n)
    out.sort(key=lambda n: n["liked_count"], reverse=True)
    return out

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
    record = {**data, "created_by": user["id"], "status": status, "owners": [user["id"]]}
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
        "owners": [user["id"]],
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

class OwnersBody(BaseModel):
    owner_ids: List[str]   # accounts that co-own (can manage) this work

@router.patch("/{novel_id}/owners", dependencies=[Depends(require_admin)])
def set_owners(novel_id: str, body: OwnersBody, sb: Client = Depends(get_supabase_admin)):
    res = sb.table("novels").update({"owners": body.owner_ids}).eq("id", novel_id).execute()
    if not res.data:
        raise HTTPException(404, "Novel not found")
    return res.data[0]

class SeriesBody(BaseModel):
    series: Optional[str] = None       # series name; null/empty = standalone
    series_order: int = 0              # position within the series (1=上, 2=下, ...)

@router.patch("/{novel_id}/series", dependencies=[Depends(require_admin)])
def set_series(novel_id: str, body: SeriesBody, sb: Client = Depends(get_supabase_admin)):
    name = (body.series or "").strip() or None
    res = sb.table("novels").update({
        "series": name,
        "series_order": body.series_order if name else 0,
    }).eq("id", novel_id).execute()
    if not res.data:
        raise HTTPException(404, "Novel not found")
    return res.data[0]

@router.patch("/{novel_id}")
def update_novel(novel_id: str, body: NovelUpdate, user: dict = Depends(require_writer), sb: Client = Depends(get_supabase_admin)):
    nv = sb.table("novels").select("owners").eq("id", novel_id).single().execute()
    if not nv.data:
        raise HTTPException(404, "Novel not found")
    if not is_admin(user) and user["id"] not in (nv.data.get("owners") or []):
        raise HTTPException(403, "只能編輯自己的作品")
    updates = {k: v for k, v in body.dict().items() if v is not None}
    published_at = updates.pop("published_at", None)
    if published_at:
        updates["created_at"] = published_at   # the 發佈日期 shown on the shelf
    if not updates:
        raise HTTPException(400, "No fields to update")
    updates["updated_at"] = "now()"
    res = sb.table("novels").update(updates).eq("id", novel_id).execute()
    return res.data[0]

@router.delete("/{novel_id}", dependencies=[Depends(require_admin)])
def delete_novel(novel_id: str, sb: Client = Depends(get_supabase_admin)):
    sb.table("novels").delete().eq("id", novel_id).execute()
    return {"message": "Deleted"}

# ── Comment likes (forum 蓋樓) ───────────────────────────────
@router.get("/{novel_id}/likes")
def get_comment_likes(novel_id: str, user: dict = Depends(get_current_user), sb: Client = Depends(get_supabase_admin)):
    rows = sb.table("comment_likes").select("comment_index, user_id").eq("novel_id", novel_id).execute().data or []
    counts, mine = {}, []
    for r in rows:
        idx = r["comment_index"]
        counts[idx] = counts.get(idx, 0) + 1
        if r["user_id"] == user["id"]:
            mine.append(idx)
    return {"counts": counts, "mine": mine}

@router.post("/{novel_id}/comments/{idx}/like")
def toggle_comment_like(novel_id: str, idx: int, user: dict = Depends(get_current_user), sb: Client = Depends(get_supabase_admin)):
    existing = (sb.table("comment_likes").select("id")
                .eq("novel_id", novel_id).eq("comment_index", idx).eq("user_id", user["id"]).execute().data)
    if existing:
        sb.table("comment_likes").delete().eq("id", existing[0]["id"]).execute()
        liked = False
    else:
        sb.table("comment_likes").insert({"novel_id": novel_id, "comment_index": idx, "user_id": user["id"]}).execute()
        liked = True
    cnt = sb.table("comment_likes").select("id", count="exact").eq("novel_id", novel_id).eq("comment_index", idx).execute()
    return {"liked": liked, "count": cnt.count or 0}

def _check_novel_access(novel: dict, user: dict):
    # Approved works are visible to every logged-in user.
    # Pending works are visible only to admins and the creator (for preview/review).
    if novel.get("category") == "迷情劑" and not can_see_mqj(user):
        raise HTTPException(403, "迷情劑分類需管理員開放才能閱讀")
    if novel.get("status") == "approved":
        return
    if is_admin(user) or user["id"] in (novel.get("owners") or []):
        return
    raise HTTPException(403, "This work is awaiting approval")
