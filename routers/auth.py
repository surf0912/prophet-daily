from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from deps import get_supabase, get_supabase_admin, get_current_user
from supabase import Client

router = APIRouter()

INTERNAL_DOMAIN = "prophet-daily.internal"

def username_to_email(username: str) -> str:
    return f"{username.lower()}@{INTERNAL_DOMAIN}"

class SignInRequest(BaseModel):
    username: str
    password: str

class SignUpRequest(BaseModel):
    username: str
    password: str

@router.post("/signin")
def signin(body: SignInRequest, sb: Client = Depends(get_supabase)):
    email = username_to_email(body.username)
    try:
        res = sb.auth.sign_in_with_password({"email": email, "password": body.password})
    except Exception:
        raise HTTPException(401, "用戶名或密碼錯誤")
    if res.session is None:
        raise HTTPException(401, "用戶名或密碼錯誤")
    return {
        "access_token": res.session.access_token,
        "refresh_token": res.session.refresh_token,
        "user": {"id": res.user.id},
    }

@router.get("/me")
def me(user: dict = Depends(get_current_user)):
    return user
