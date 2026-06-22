from datetime import datetime, timezone, timedelta
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
    # mine=true → only the caller's own works (any status), for 作品管理.
    if mine:
        q = sb.table("novels").select("*")
        if kind:
            q = q.eq("kind", kind)
        q = q.contains("owners", [user["id"]])
        return q.order("created_at", desc=True).execute().data

    # Public shelf: everyone sees APPROVED works (admins also see pending for review),
    # never the per-writer 作家入職指南 demo works. is_guide filter is applied defensively
    # so the shelf keeps working even before the is_guide column exists.
    def fetch(use_guide_filter: bool):
        q = sb.table("novels").select("*")
        if kind:
            q = q.eq("kind", kind)
        if use_guide_filter:
            q = q.eq("is_guide", False)
        if not is_admin(user):
            q = q.eq("status", "approved")
        return q.order("created_at", desc=True).execute().data
    try:
        data = fetch(True)
    except Exception:
        data = fetch(False)
    # Scheduled publish: hide a work only if its 發佈日期 is a FUTURE calendar day. We compare by
    # day in the group's timezone (UTC+8) so a work dated "today" shows all day, and a work dated
    # tomorrow stays hidden until that day. Owners still see it in 作品管理 (mine=true); admins see all.
    if not is_admin(user):
        from datetime import datetime, timezone, timedelta
        TW = timezone(timedelta(hours=8))
        today_tw = datetime.now(TW).date()
        def _live(n):
            ts = n.get("created_at")
            if not ts:
                return True
            try:
                return datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone(TW).date() <= today_tw
            except Exception:
                return True
        data = [n for n in data if _live(n)]
    # Readers without 迷情劑 access don't see 迷情劑 works.
    if not can_see_mqj(user):
        data = [n for n in data if n.get("category") != "迷情劑"]
    # Author-locked works exist only for super_admin here; the author still sees/manages their own
    # via mine=true (作品管理). .get() is None-safe before the `locked` column is added.
    if user.get("role") != "super_admin":
        data = [n for n in data if not n.get("locked")]
    return data

@router.get("/{novel_id}/siblings")
def list_series_siblings(novel_id: str, user: dict = Depends(get_current_user), sb: Client = Depends(get_supabase_admin)):
    """Ordered parts of this work's series, INCLUDING 迷情劑 parts the caller can't read yet — those
    come back as locked stubs (no title) so the reader's 上下篇 nav can surface a 'request access'
    gate instead of silently skipping them. Visibility otherwise matches the public shelf."""
    cur = sb.table("novels").select("series, kind").eq("id", novel_id).execute().data
    cur = cur[0] if cur else None
    if not cur or not cur.get("series") or cur.get("kind") == "forum":
        return []
    rows = sb.table("novels").select(
        "id, title, series, series_order, category, status, owners, created_at, is_guide"
    ).eq("series", cur["series"]).execute().data or []
    TW = timezone(timedelta(hours=8))
    today_tw = datetime.now(TW).date()
    admin = is_admin(user)
    def visible(n):
        if n.get("is_guide"):
            return False
        if not (admin or n.get("status") == "approved" or user["id"] in (n.get("owners") or [])):
            return False
        if not admin:   # scheduled-publish: hide future-dated parts
            ts = n.get("created_at")
            try:
                if ts and datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone(TW).date() > today_tw:
                    return False
            except Exception:
                pass
        return True
    out = []
    for n in rows:
        if not visible(n):
            continue
        locked = n.get("category") == "迷情劑" and not can_see_mqj(user)
        out.append({
            "id": n["id"],
            "title": None if locked else n.get("title"),   # never leak a locked work's title
            "series_order": n.get("series_order") or 0,
            "category": n.get("category"),
            "locked": locked,
            "created_at": n.get("created_at"),
        })
    out.sort(key=lambda x: (x["series_order"], x.get("created_at") or ""))
    return out

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

# Top-3 "hot" works over the last 24h (distinct viewers + weighted favorites). Returns ids
# only; the client floats them to the top of the shelf silently (no label). Needs novel_views.
@router.get("/hot")
def hot_novels(user: dict = Depends(get_current_user), sb: Client = Depends(get_supabase_admin)):
    since = (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat()
    score: dict = {}
    try:
        for v in (sb.table("novel_views").select("novel_id").gte("created_at", since).execute().data or []):
            score[v["novel_id"]] = score.get(v["novel_id"], 0) + 1            # 1 per distinct recent viewer
        for f in (sb.table("novel_favorites").select("novel_id").gte("created_at", since).execute().data or []):
            score[f["novel_id"]] = score.get(f["novel_id"], 0) + 3            # a favorite weighs more
    except Exception:
        return []
    if not score:
        return []
    rows = sb.table("novels").select("id, status, kind").in_("id", list(score.keys())).execute().data or []
    ok = {r["id"] for r in rows if r.get("status") == "approved" and r.get("kind") == "novel"}
    ranked = sorted((i for i in score if i in ok), key=lambda i: score[i], reverse=True)
    return ranked[:3]

# Whole-work favorites (意若思鏡 收藏夾). Needs a novel_favorites(user_id, novel_id) table.
@router.get("/my-favorite-ids")
def my_favorite_ids(user: dict = Depends(get_current_user), sb: Client = Depends(get_supabase_admin)):
    rows = sb.table("novel_favorites").select("novel_id").eq("user_id", user["id"]).execute().data or []
    return [r["novel_id"] for r in rows]

@router.get("/{novel_id}")
def get_novel(novel_id: str, user: dict = Depends(get_current_user), sb: Client = Depends(get_supabase_admin)):
    rows = sb.table("novels").select("*").eq("id", novel_id).limit(1).execute().data
    if not rows:
        raise HTTPException(404, "Novel not found")   # .single() raises on a missing/deleted id (→500), so use limit(1)
    _check_novel_access(rows[0], user)
    return rows[0]

def _upload_status(user: dict, sb: Client) -> str:
    # Admin/super_admin publish immediately; writers an admin has granted 自動審核 (auto_publish)
    # also publish without review; everyone else awaits approval.
    if is_admin(user) or user.get("auto_publish"):
        return "approved"
    return "pending"

@router.post("/", dependencies=[Depends(require_writer)])
def create_novel(body: NovelCreate, user: dict = Depends(require_writer), sb: Client = Depends(get_supabase_admin)):
    if body.category == "迷情劑" and not can_see_mqj(user):
        raise HTTPException(403, "你尚未取得迷情劑權限，無法上傳此分類")
    # Admin/super_admin uploads are public immediately; writers' uploads await approval.
    status = _upload_status(user, sb)
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
    if body.category == "迷情劑" and not can_see_mqj(user):
        raise HTTPException(403, "你尚未取得迷情劑權限，無法上傳此分類")
    # A forum post is a kind='forum' novel whose single chapter holds the body text.
    status = _upload_status(user, sb)
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

@router.patch("/{novel_id}/series")
def set_series(novel_id: str, body: SeriesBody, user: dict = Depends(require_writer), sb: Client = Depends(get_supabase_admin)):
    rows = sb.table("novels").select("owners").eq("id", novel_id).limit(1).execute().data
    if not rows:
        raise HTTPException(404, "Novel not found")
    if not is_admin(user) and user["id"] not in (rows[0].get("owners") or []):
        raise HTTPException(403, "只能管理自己的作品")
    name = (body.series or "").strip() or None
    res = sb.table("novels").update({
        "series": name,
        "series_order": body.series_order if name else 0,
    }).eq("id", novel_id).execute()
    return res.data[0]

@router.patch("/{novel_id}")
def update_novel(novel_id: str, body: NovelUpdate, user: dict = Depends(require_writer), sb: Client = Depends(get_supabase_admin)):
    rows = sb.table("novels").select("owners").eq("id", novel_id).limit(1).execute().data
    if not rows:
        raise HTTPException(404, "Novel not found")
    if not is_admin(user) and user["id"] not in (rows[0].get("owners") or []):
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

@router.delete("/{novel_id}")
def delete_novel(novel_id: str, user: dict = Depends(require_writer), sb: Client = Depends(get_supabase_admin)):
    rows = sb.table("novels").select("owners").eq("id", novel_id).limit(1).execute().data
    if not rows:
        raise HTTPException(404, "Novel not found")
    if not is_admin(user) and user["id"] not in (rows[0].get("owners") or []):
        raise HTTPException(403, "只能刪除自己的作品")
    sb.table("novels").delete().eq("id", novel_id).execute()
    return {"message": "Deleted"}

class LockBody(BaseModel):
    locked: bool

@router.patch("/{novel_id}/lock")
def set_locked(novel_id: str, body: LockBody, user: dict = Depends(require_writer), sb: Client = Depends(get_supabase_admin)):
    """Author (an owner) or super_admin hides/unhides a work. A locked work exists only for its
    owners and super_admin — it vanishes from everyone else's shelf, search and reader (enforced in
    list_novels + _check_novel_access). A plain admin who isn't an owner cannot lock it."""
    rows = sb.table("novels").select("owners").eq("id", novel_id).limit(1).execute().data
    if not rows:
        raise HTTPException(404, "Novel not found")
    if user.get("role") != "super_admin" and user["id"] not in (rows[0].get("owners") or []):
        raise HTTPException(403, "只能鎖自己的作品")
    res = sb.table("novels").update({"locked": body.locked}).eq("id", novel_id).execute()
    return res.data[0] if res.data else {"id": novel_id, "locked": body.locked}

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

@router.post("/{novel_id}/favorite")
def toggle_favorite(novel_id: str, user: dict = Depends(get_current_user), sb: Client = Depends(get_supabase_admin)):
    existing = (sb.table("novel_favorites").select("user_id")
                .eq("user_id", user["id"]).eq("novel_id", novel_id).execute().data)
    if existing:
        sb.table("novel_favorites").delete().eq("user_id", user["id"]).eq("novel_id", novel_id).execute()
        return {"favorited": False}
    # Adding a new favourite: block 迷情劑 works the caller can't read (backstop — the UI already
    # hides the ☆ on the access-gate page). Un-favouriting above is always allowed.
    nv = sb.table("novels").select("category").eq("id", novel_id).execute().data
    if nv and nv[0].get("category") == "迷情劑" and not can_see_mqj(user):
        raise HTTPException(403, "迷情劑分類需管理員開放才能收藏")
    sb.table("novel_favorites").insert({"user_id": user["id"], "novel_id": novel_id}).execute()
    return {"favorited": True}

@router.post("/{novel_id}/view")
def log_view(novel_id: str, user: dict = Depends(get_current_user), sb: Client = Depends(get_supabase_admin)):
    # Record one view per user per work per 24h (so a single reader can't inflate the hot ranking).
    since = (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat()
    try:
        existing = (sb.table("novel_views").select("id")
                    .eq("novel_id", novel_id).eq("user_id", user["id"]).gte("created_at", since).execute().data)
        if not existing:
            sb.table("novel_views").insert({"novel_id": novel_id, "user_id": user["id"]}).execute()
    except Exception:
        pass  # view logging is best-effort; never block reading
    return {"ok": True}

def _check_novel_access(novel: dict, user: dict):
    # Author-locked → invisible to all but super_admin + owners. 404 (not 403) so it doesn't reveal
    # the work exists. Owners are exempt so the author can still preview their own locked work.
    if novel.get("locked") and user.get("role") != "super_admin" and user["id"] not in (novel.get("owners") or []):
        raise HTTPException(404, "Novel not found")
    # Approved works are visible to every logged-in user.
    # Pending works are visible only to admins and the creator (for preview/review).
    if novel.get("category") == "迷情劑" and not can_see_mqj(user):
        raise HTTPException(403, "迷情劑分類需管理員開放才能閱讀")
    if novel.get("status") == "approved":
        return
    if is_admin(user) or user["id"] in (novel.get("owners") or []):
        return
    raise HTTPException(403, "This work is awaiting approval")
