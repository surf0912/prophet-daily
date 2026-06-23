import base64
import os
import re
import unittest
from pathlib import Path

os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_ANON_KEY", "test-anon")
os.environ.setdefault("SUPABASE_SERVICE_KEY", "test-service")
os.environ.setdefault("JWT_SECRET", "test-jwt-secret")

from fastapi import HTTPException

from deps import validate_image_data_url


def image_data_url(kind: str, raw: bytes) -> str:
    return f"data:image/{kind};base64," + base64.b64encode(raw).decode("ascii")


class AvatarValidationTests(unittest.TestCase):
    def test_accepts_allowed_image_signatures(self):
        valid = [
            image_data_url("jpeg", b"\xff\xd8\xffpayload"),
            image_data_url("png", b"\x89PNG\r\n\x1a\npayload"),
            image_data_url("webp", b"RIFF\x00\x00\x00\x00WEBPpayload"),
        ]
        for value in valid:
            with self.subTest(value=value[:30]):
                self.assertEqual(validate_image_data_url(value, 1_000), value)

    def test_rejects_active_or_malformed_data_urls(self):
        invalid = [
            "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
            'data:image/jpeg;base64,abc" onerror=alert(1)',
            image_data_url("jpeg", b"\x89PNG\r\n\x1a\npayload"),
            "data:image/png;base64,not-valid-@@@",
        ]
        for value in invalid:
            with self.subTest(value=value[:40]):
                with self.assertRaises(HTTPException):
                    validate_image_data_url(value, 1_000)

    def test_empty_value_clears_avatar(self):
        self.assertEqual(validate_image_data_url("", 1_000), "")


class FrontendOutputSafetyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.html = (Path(__file__).parents[1] / "index.html").read_text(encoding="utf-8")

    def test_known_stored_xss_sinks_stay_encoded(self):
        required = [
            "escapeHtml(n.author || '佚名')",
            "escapeHtml(n.title)",
            "escapeHtml(p.author || '匿名')",
            "escapeHtml(c.title || '章節 ' + c.chapter_num)",
            "escapeHtml(n.category)",
        ]
        for expression in required:
            with self.subTest(expression=expression):
                self.assertIn(expression, self.html)

    def test_avatar_values_are_filtered_before_html_or_css(self):
        self.assertIn("function safeAvatarDataUrl(value)", self.html)
        self.assertNotIn("background:url('${u.avatar_url}')", self.html)
        self.assertNotIn("background-image:url('${c.avatar}')", self.html)

    def test_user_strings_are_not_embedded_in_inline_handlers(self):
        dangerous = [
            "JSON.stringify(sc.name)",
            "JSON.stringify(n.title)",
            "'${escapeHtml(sc.name)}'",
        ]
        for expression in dangerous:
            with self.subTest(expression=expression):
                self.assertNotIn(expression, self.html)

    def test_app_and_service_worker_versions_match(self):
        worker = (Path(__file__).parents[1] / "service-worker.js").read_text(encoding="utf-8")
        app_version = re.search(r"APP_VERSION = '(v[\d.]+)'", self.html).group(1)
        cache_version = re.search(r"prophet-daily-(v[\d.]+)", worker).group(1)
        self.assertEqual(app_version, cache_version)


class DatabaseBoundaryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        root = Path(__file__).parents[1]
        cls.schema = (root / "supabase" / "schema.sql").read_text(encoding="utf-8")
        cls.migration = (root / "supabase" / "migrations" /
                         "20260623_lock_down_database_boundary.sql").read_text(encoding="utf-8")
        cls.invites = (root / "routers" / "invites.py").read_text(encoding="utf-8")

    def test_signup_trigger_never_trusts_metadata_role(self):
        for sql in (self.schema, self.migration):
            with self.subTest(sql=sql[:40]):
                self.assertNotIn("new.raw_user_meta_data->>'role'", sql)
                self.assertRegex(sql, r"split_part\(new\.email, '@', 1\)\),\s*'reader'")

    def test_direct_client_table_privileges_are_revoked(self):
        required = [
            "revoke all privileges on all tables in schema public from anon, authenticated",
            "revoke all privileges on all sequences in schema public from anon, authenticated",
        ]
        for statement in required:
            with self.subTest(statement=statement):
                self.assertIn(statement, self.schema.lower())
                self.assertIn(statement, self.migration.lower())

    def test_invite_backend_explicitly_grants_claimed_role(self):
        self.assertIn('{"nickname": nickname, "role": inv["role"]}', self.invites)
        self.assertIn('.eq("used_at", now_iso).is_("used_by", "null")', self.invites)


class DependencyLockTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        root = Path(__file__).parents[1]
        cls.entry = (root / "requirements.txt").read_text(encoding="utf-8")
        cls.lock = (root / "requirements.lock").read_text(encoding="utf-8")
        cls.workflow = (root / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")

    def test_render_installs_the_committed_lock(self):
        active = [line.strip() for line in self.entry.splitlines()
                  if line.strip() and not line.lstrip().startswith("#")]
        self.assertEqual(active, ["-r requirements.lock"])

    def test_every_locked_requirement_is_exact(self):
        requirements = [line.strip() for line in self.lock.splitlines()
                        if line.strip() and not line.lstrip().startswith("#")]
        self.assertGreater(len(requirements), 30)
        for requirement in requirements:
            with self.subTest(requirement=requirement):
                self.assertRegex(requirement, r"^[A-Za-z0-9_.-]+==[^=]+$")

    def test_ci_installs_and_audits_the_same_lock(self):
        self.assertIn("pip install -r requirements.lock", self.workflow)
        self.assertIn("pip-audit -r requirements.lock", self.workflow)


if __name__ == "__main__":
    unittest.main()
