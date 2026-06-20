from datetime import datetime, timezone, timedelta
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional
from deps import get_supabase_admin, get_current_user, require_admin, is_admin
from supabase import Client

router = APIRouter()

# Per-kind limits: (max characters, max submissions per day per user)
LIMITS = {"wish": (140, 3), "bug": (600, 10)}

def _today_start_iso() -> str:
    # Start of the current day in Taiwan (UTC+8), converted to UTC for the created_at compare,
    # so the daily quota resets at local midnight (matches the coin display).
    tw = timezone(timedelta(hours=8))
    start_tw = datetime.now(tw).replace(hour=0, minute=0, second=0, microsecond=0)
    return start_tw.astimezone(timezone.utc).isoformat()

# ── Wishes / bug reports (shared `feedback` table) ───────────
class FeedbackCreate(BaseModel):
    kind: str           # 'wish' | 'bug'
    content: str

@router.get("/")
def list_feedback(kind: str, user: dict = Depends(get_current_user), sb: Client = Depends(get_supabase_admin)):
    if kind not in LIMITS:
        raise HTTPException(400, "Invalid kind")
    q = sb.table("feedback").select("*").eq("kind", kind).order("created_at", desc=True)
    # Wishes are public; bug reports are private (own + admins) since they can mention account details.
    if kind == "bug" and not is_admin(user):
        q = q.eq("user_id", user["id"])
    rows = q.execute().data or []
    # Attach author display name (nickname) via a second lookup — robust, no FK-embed magic.
    uids = list({r["user_id"] for r in rows if r.get("user_id")})
    names = {}
    if uids:
        profs = sb.table("profiles").select("id, nickname, username").in_("id", uids).execute().data or []
        names = {p["id"]: (p.get("nickname") or p.get("username") or "讀者") for p in profs}
    for r in rows:
        r["author"] = names.get(r.get("user_id"), "讀者")
        r["mine"] = r.get("user_id") == user["id"]
    return rows

@router.post("/")
def create_feedback(body: FeedbackCreate, user: dict = Depends(get_current_user), sb: Client = Depends(get_supabase_admin)):
    if body.kind not in LIMITS:
        raise HTTPException(400, "Invalid kind")
    max_len, per_day = LIMITS[body.kind]
    content = (body.content or "").strip()
    if not content:
        raise HTTPException(400, "內容不能空白")
    if len(content) > max_len:
        raise HTTPException(400, f"最多 {max_len} 字")
    # Daily per-user rate limit.
    today = sb.table("feedback").select("id", count="exact") \
        .eq("user_id", user["id"]).eq("kind", body.kind).gte("created_at", _today_start_iso()).execute()
    if (today.count or 0) >= per_day:
        label = "許願" if body.kind == "wish" else "回報"
        raise HTTPException(429, f"今天的{label}次數已用完（每天最多 {per_day} 次），明天再來吧")
    res = sb.table("feedback").insert({
        "user_id": user["id"], "kind": body.kind, "content": content, "status": "open",
    }).execute()
    return res.data[0]

class FeedbackUpdate(BaseModel):
    status: Optional[str] = None
    admin_reply: Optional[str] = None

@router.patch("/{fb_id}", dependencies=[Depends(require_admin)])
def update_feedback(fb_id: str, body: FeedbackUpdate, sb: Client = Depends(get_supabase_admin)):
    updates = {k: v for k, v in body.dict().items() if v is not None}
    if not updates:
        raise HTTPException(400, "No fields to update")
    res = sb.table("feedback").update(updates).eq("id", fb_id).execute()
    if not res.data:
        raise HTTPException(404, "Not found")
    return res.data[0]

@router.delete("/{fb_id}")
def delete_feedback(fb_id: str, user: dict = Depends(get_current_user), sb: Client = Depends(get_supabase_admin)):
    row = sb.table("feedback").select("user_id").eq("id", fb_id).single().execute()
    if not row.data:
        raise HTTPException(404, "Not found")
    if not is_admin(user) and row.data["user_id"] != user["id"]:
        raise HTTPException(403, "只能刪除自己的")
    sb.table("feedback").delete().eq("id", fb_id).execute()
    return {"message": "deleted"}

# ── FAQ (admin-authored Q&A) ─────────────────────────────────
class FaqBody(BaseModel):
    question: str
    answer: str
    sort_order: Optional[int] = 0

@router.get("/faqs")
def list_faqs(user: dict = Depends(get_current_user), sb: Client = Depends(get_supabase_admin)):
    return sb.table("faqs").select("*").order("sort_order").order("created_at").execute().data

@router.post("/faqs", dependencies=[Depends(require_admin)])
def create_faq(body: FaqBody, sb: Client = Depends(get_supabase_admin)):
    res = sb.table("faqs").insert({
        "question": body.question.strip(), "answer": body.answer.strip(), "sort_order": body.sort_order or 0,
    }).execute()
    return res.data[0]

@router.patch("/faqs/{faq_id}", dependencies=[Depends(require_admin)])
def update_faq(faq_id: str, body: FaqBody, sb: Client = Depends(get_supabase_admin)):
    res = sb.table("faqs").update({
        "question": body.question.strip(), "answer": body.answer.strip(), "sort_order": body.sort_order or 0,
    }).eq("id", faq_id).execute()
    if not res.data:
        raise HTTPException(404, "Not found")
    return res.data[0]

@router.delete("/faqs/{faq_id}", dependencies=[Depends(require_admin)])
def delete_faq(faq_id: str, sb: Client = Depends(get_supabase_admin)):
    sb.table("faqs").delete().eq("id", faq_id).execute()
    return {"message": "deleted"}
