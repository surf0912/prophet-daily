from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional, List
from deps import get_supabase_admin, require_admin, get_current_user, validate_image_data_url
from supabase import Client

# ── 自創角色 (private custom characters) — EXPERIMENTAL ─────────────────────────
# Each user can create their own characters (name + avatar). FULLY PRIVATE: every row is scoped to
# user_id and never touches any public/shared record, so no one — not even via the raw API/DB — can
# see another person's custom characters. Beta-gated to super_admin for now; open to writer+ later
# by relaxing the dependency. Work-tagging (which works belong under a custom character) is a
# separate phase and will live in its own private table, leaving the public works untouched.
#
# Needs a Supabase table:
#   create table if not exists custom_characters (
#     id uuid primary key default gen_random_uuid(), user_id uuid not null,
#     name text not null, avatar text, created_at timestamptz not null default now());

router = APIRouter()
MAX_AVATAR = 1_500_000   # ~1.5MB of base64 avatar — keep DB rows sane

class CharBody(BaseModel):
    name: Optional[str] = None
    avatar: Optional[str] = None      # base64 data URL, like profile avatars
    shared_with: Optional[List[str]] = None   # user_ids the owner shares this character with (read-only)

def _check_avatar(av):
    return validate_image_data_url(av, MAX_AVATAR)

def _clean_shared(ids):
    # dedupe, drop blanks, cap. Stored as text[] of user_ids the owner opted to share with.
    if not ids:
        return []
    return [str(x) for x in dict.fromkeys(ids) if x][:200]

@router.get("/")
def my_chars(user: dict = Depends(get_current_user), sb: Client = Depends(get_supabase_admin)):
    # Readable by ANY member (creating stays admin-only): own characters PLUS any an owner shared
    # with me (read-only). A non-admin only ever gets shared ones (they can't create their own). `mine` distinguishes them; the
    # shared audience list is stripped from chars I don't own.
    uid = user["id"]
    # Decide visibility in Python, NOT with an array `contains` filter: in Postgres `arr @> '{}'` is
    # TRUE for every array, so a `cs.{}`-style query would leak every empty-shared character. A char
    # is visible ONLY if I own it, or my id is literally a member of its shared_with list.
    meta = sb.table("custom_characters").select("id, user_id, shared_with").order("created_at").execute().data or []
    mine = {}
    for c in meta:
        if c.get("user_id") == uid:
            mine[c["id"]] = True
        elif uid in (c.get("shared_with") or []):
            mine[c["id"]] = False
    if not mine:
        return []
    full = (sb.table("custom_characters").select("*").in_("id", list(mine.keys()))
            .order("created_at").execute().data or [])
    for c in full:
        c["mine"] = mine.get(c["id"], True)
        if c["mine"] is False:
            c.pop("shared_with", None)
    return full

@router.post("/")
def add_char(body: CharBody, user: dict = Depends(require_admin), sb: Client = Depends(get_supabase_admin)):
    name = (body.name or "").strip()[:20]
    if not name:
        raise HTTPException(400, "角色名稱不能空白")
    avatar = _check_avatar(body.avatar)
    rows = sb.table("custom_characters").insert({
        "user_id": user["id"], "name": name, "avatar": avatar or None,
        "shared_with": _clean_shared(body.shared_with),
    }).execute().data
    return rows[0] if rows else {}

@router.patch("/{char_id}")
def edit_char(char_id: str, body: CharBody, user: dict = Depends(require_admin), sb: Client = Depends(get_supabase_admin)):
    upd = {}
    if body.name is not None and body.name.strip():
        upd["name"] = body.name.strip()[:20]
    if body.avatar is not None:
        upd["avatar"] = _check_avatar(body.avatar) or None
    if body.shared_with is not None:
        upd["shared_with"] = _clean_shared(body.shared_with)
    if not upd:
        raise HTTPException(400, "沒有要更新的內容")
    # user_id filter keeps it own-only even though the route is super_admin-gated.
    rows = sb.table("custom_characters").update(upd).eq("id", char_id).eq("user_id", user["id"]).execute().data
    if not rows:
        raise HTTPException(404, "找不到角色")
    return rows[0]

# ── work tagging: which works the user filed under each custom character (private) ─────────────
# Stored in its OWN table custom_char_tags(user_id, char_id, novel_id) — the public novels record is
# never touched, so no one can see another person's tags even via the raw API/DB.
#   create table if not exists custom_char_tags (
#     user_id uuid not null, char_id uuid not null, novel_id uuid not null,
#     created_at timestamptz not null default now(), primary key (user_id, char_id, novel_id));

class TagBody(BaseModel):
    novel_id: str
    char_ids: List[str] = []

@router.get("/tags")
def my_tags(user: dict = Depends(get_current_user), sb: Client = Depends(get_supabase_admin)):
    # Tags for the characters I can SEE — mine + ones shared with me. Tags belong to each char's
    # owner (set_tags only lets you tag your own characters), so fetching by char_id is unambiguous.
    uid = user["id"]
    # Same explicit visibility check as my_chars (never an array `contains` filter — see note there).
    meta = sb.table("custom_characters").select("id, user_id, shared_with").execute().data or []
    visible = [c["id"] for c in meta if c.get("user_id") == uid or uid in (c.get("shared_with") or [])]
    if not visible:
        return []
    return (sb.table("custom_char_tags").select("char_id, novel_id").in_("char_id", visible).execute().data or [])

@router.post("/tag")
def set_tags(body: TagBody, user: dict = Depends(require_admin), sb: Client = Depends(get_supabase_admin)):
    """Replace which custom characters a single work is filed under. You can only tag your OWN
    characters — tagging a shared character (someone else's) is silently ignored."""
    owned = {c["id"] for c in (sb.table("custom_characters").select("id").eq("user_id", user["id"]).execute().data or [])}
    sb.table("custom_char_tags").delete().eq("user_id", user["id"]).eq("novel_id", body.novel_id).execute()
    ids = [c for c in dict.fromkeys(body.char_ids) if c and c in owned]   # dedupe, drop blanks + non-owned
    if ids:
        sb.table("custom_char_tags").insert(
            [{"user_id": user["id"], "novel_id": body.novel_id, "char_id": c} for c in ids]).execute()
    return {"ok": True}

@router.delete("/{char_id}")
def del_char(char_id: str, user: dict = Depends(require_admin), sb: Client = Depends(get_supabase_admin)):
    sb.table("custom_char_tags").delete().eq("user_id", user["id"]).eq("char_id", char_id).execute()  # cascade its tags
    sb.table("custom_characters").delete().eq("id", char_id).eq("user_id", user["id"]).execute()
    return {"message": "deleted"}
