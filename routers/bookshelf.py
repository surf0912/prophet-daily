from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from deps import get_supabase_admin, require_super_admin
from supabase import Client

# ── 個人書櫃 (private bookshelf) — EXPERIMENTAL ────────────────────────────────
# A private, per-user space: create your own 角色標籤 (free-text), upload a .txt / paste text
# under it, filed by 迷情劑/吐真劑/儲思盆. Never public — every query is scoped to user["id"].
# Beta-gated to super_admin for now (require_super_admin); open it up later by relaxing the dep.
# Needs a Supabase table:
#   create table if not exists bookshelf (
#     id uuid primary key default gen_random_uuid(),
#     user_id uuid not null, title text, content text not null,
#     char_tag text, category text, created_at timestamptz not null default now());

router = APIRouter()

CATS = {"迷情劑", "吐真劑", "儲思盆"}      # 暫不含羊皮紙
MAX_CONTENT = 100_000                      # ~100KB of text per piece — keep DB rows sane

class PieceBody(BaseModel):
    title: str
    content: str
    char_tag: str
    category: str

@router.get("/")
def my_bookshelf(user: dict = Depends(require_super_admin), sb: Client = Depends(get_supabase_admin)):
    return (sb.table("bookshelf").select("*")
            .eq("user_id", user["id"]).order("created_at", desc=True).execute().data or [])

@router.post("/")
def add_piece(body: PieceBody, user: dict = Depends(require_super_admin), sb: Client = Depends(get_supabase_admin)):
    content = (body.content or "").strip()
    if not content:
        raise HTTPException(400, "內容不能空白")
    if len(content) > MAX_CONTENT:
        raise HTTPException(400, "內容過長（上限約 10 萬字）")
    rows = sb.table("bookshelf").insert({
        "user_id": user["id"],
        "title": (body.title or "").strip()[:120] or "未命名",
        "content": content,
        "char_tag": (body.char_tag or "").strip()[:40],
        "category": body.category if body.category in CATS else "儲思盆",
    }).execute().data
    return rows[0] if rows else {}

@router.delete("/{piece_id}")
def del_piece(piece_id: str, user: dict = Depends(require_super_admin), sb: Client = Depends(get_supabase_admin)):
    # user_id filter makes this own-only even though super_admin gates the route.
    sb.table("bookshelf").delete().eq("id", piece_id).eq("user_id", user["id"]).execute()
    return {"message": "deleted"}
