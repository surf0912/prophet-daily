import io
import uuid
import pytesseract
from PIL import Image
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form
from typing import Optional
from deps import get_supabase_admin, get_current_user, require_admin, is_admin
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
    sb: Client = Depends(get_supabase_admin),
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
    return res.data[0]

@router.delete("/{chapter_id}", dependencies=[Depends(require_admin)])
def delete_chapter(chapter_id: str, sb: Client = Depends(get_supabase_admin)):
    sb.table("chapters").delete().eq("id", chapter_id).execute()
    return {"message": "Deleted"}

def _check_novel_access(novel_id: str, user: dict, sb: Client):
    if is_admin(user):
        return
    perm = sb.table("permissions").select("id").eq("user_id", user["id"]).eq("novel_id", novel_id).execute()
    if not perm.data:
        raise HTTPException(403, "No access to this novel")
