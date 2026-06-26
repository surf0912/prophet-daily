from fastapi import APIRouter, Depends
from pydantic import BaseModel
from supabase import Client

from deps import get_current_user, get_supabase_admin, require_super_admin

router = APIRouter()


class SettingBody(BaseModel):
    value: str


# Global site settings (key → value). Any signed-in user may READ — clients need e.g. the
# notification-centre retention window — but only super_admin may WRITE.
@router.get("/")
def get_settings(user: dict = Depends(get_current_user), sb: Client = Depends(get_supabase_admin)):
    try:
        rows = sb.table("app_settings").select("key, value").execute().data or []
    except Exception:
        return {}   # table not migrated yet → clients fall back to their defaults
    return {r["key"]: r.get("value") for r in rows}


@router.put("/{key}", dependencies=[Depends(require_super_admin)])
def set_setting(key: str, body: SettingBody, sb: Client = Depends(get_supabase_admin)):
    sb.table("app_settings").upsert({"key": key, "value": body.value}).execute()
    return {"key": key, "value": body.value}
