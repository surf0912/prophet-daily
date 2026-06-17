import io
from fastapi import APIRouter, Depends, UploadFile, File, Form
from fastapi.responses import Response
from typing import Optional
from deps import get_current_user
from processor import protect_bytes, config_from_preset

router = APIRouter()

@router.post("/image")
async def protect_image(
    image: UploadFile = File(...),
    preset: Optional[str] = Form("standard"),
    _user: dict = Depends(get_current_user),
):
    img_bytes = await image.read()
    # Preset keys are capitalised (Standard/Maximum/Extreme); normalise the input.
    cfg = config_from_preset((preset or "standard").strip().capitalize())
    protected = protect_bytes(img_bytes, cfg, "JPG")  # JPG: PNG balloons on noisy output
    return Response(content=protected, media_type="image/jpeg")
