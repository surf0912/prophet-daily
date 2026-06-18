import io
import uuid
import pytesseract
from PIL import Image
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form
from pydantic import BaseModel
from typing import Optional
from deps import get_supabase, get_supabase_admin, get_current_user, require_admin, require_writer
from supabase import Client

router = APIRouter()

@router.get("/novel/{novel_id}")
def list_chapters(
    novel_id: str,
    user: dict = Depends(get_current_user),
    sb: Client = Depends(get_supabase),
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
    sb: Client = Depends(get_supabase),
):
    res = sb.table("chapters").select("*").eq("id", chapter_id).single().execute()
    if not res.data:
        raise HTTPException(404, "Chapter not found")
    _check_novel_access(res.data["novel_id"], user, sb)
    return res.data

@router.post("/novel/{novel_id}/upload")
async def upload_chapter(
    novel_id: str,
    chapter_num: int = Form(...),
    title: Optional[str] = Form(None),
    image: UploadFile = File(...),
    user: dict = Depends(require_admin),
    sb: Client = Depends(get_supabase),
    sb_admin: Client = Depends(get_supabase_admin),
):
    img_bytes = await image.read()

    # OCR
    pil_img = Image.open(io.BytesIO(img_bytes))
    ocr_text = pytesseract.image_to_string(pil_img, lang="chi_tra+eng")
    if not ocr_text.strip():
        raise HTTPException(422, "OCR returned empty text — check image quality")

    # Upload original to Supabase Storage
    storage_path = f"{novel_id}/{chapter_num}_{uuid.uuid4().hex[:8]}.png"
    sb_admin.storage.from_("novel-images").upload(
        storage_path,
        img_bytes,
        {"content-type": image.content_type or "image/png"},
    )

    # Insert chapter
    res = sb.table("chapters").insert({
        "novel_id": novel_id,
        "chapter_num": chapter_num,
        "title": title,
        "content": ocr_text.strip(),
        "source_image": storage_path,
        "created_by": user["id"],
    }).execute()
    _touch_novel(novel_id, sb_admin)
    return res.data[0]

class ChapterTextBody(BaseModel):
    chapter_num: int
    title: Optional[str] = None
    content: str

@router.post("/novel/{novel_id}/text")
def create_chapter_text(
    novel_id: str,
    body: ChapterTextBody,
    user: dict = Depends(require_writer),
    sb_admin: Client = Depends(get_supabase_admin),
):
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
    res = sb_admin.table("chapters").update({
        "chapter_num": body.chapter_num,
        "title": body.title,
        "content": body.content.strip(),
    }).eq("id", chapter_id).execute()
    if not res.data:
        raise HTTPException(404, "Chapter not found")
    return res.data[0]

@router.delete("/{chapter_id}", dependencies=[Depends(require_admin)])
def delete_chapter(chapter_id: str, sb: Client = Depends(get_supabase)):
    sb.table("chapters").delete().eq("id", chapter_id).execute()
    return {"message": "Deleted"}

def _touch_novel(novel_id: str, sb_admin: Client):
    # bump the work's "latest update" timestamp whenever a chapter is added
    sb_admin.table("novels").update({"updated_at": "now()"}).eq("id", novel_id).execute()

def _check_novel_access(novel_id: str, user: dict, sb: Client):
    if user["role"] == "admin":
        return
    perm = sb.table("permissions").select("id").eq("user_id", user["id"]).eq("novel_id", novel_id).execute()
    if not perm.data:
        raise HTTPException(403, "No access to this novel")
