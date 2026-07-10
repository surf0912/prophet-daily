"""前端輸出安全的靜態檢查（不依賴後端）。

公開 repo 只留前端，這些測試純讀 index.html / app.js / service-worker.js：
XSS 編碼沉澱點、CSP 無 inline/eval、data-on handler 全在白名單、
以及 APP_VERSION 必須等於 service-worker 的 CACHE_NAME。

後端相關的測試（avatar 驗證、DB 邊界、requirements lock、設定）已隨後端
移到私有 repo surf0912/prophet-daily-api，由該 repo 的 CI 執行。
"""
import re
import unittest
from pathlib import Path


class FrontendOutputSafetyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        root = Path(__file__).parents[1]
        cls.html = (root / "index.html").read_text(encoding="utf-8")
        cls.app = (root / "app.js").read_text(encoding="utf-8")
        cls.events = (root / "safe-events.js").read_text(encoding="utf-8")
        cls.frontend = cls.html + "\n" + cls.app

    def test_known_stored_xss_sinks_stay_encoded(self):
        required = [
            "escapeHtml(n.author || '佚名')",
            "escapeHtml(n.title)",
            "escapeHtml(p.author || '匿名')",
            "escapeHtml(c.title || '章節 ' + c.chapter_num)",
            "escapeHtml(n.category)",
            "escapeHtml(it.content)",
            "escapeHtml(r.t || '')",   # 許願池多重回覆：整串 replies 逐則跳脫（取代舊的單則 it.admin_reply）
            "escapeHtml(f.question)",
            "escapeHtml(f.answer)",
            "escapeHtml(inv.profiles?.username || '')",
        ]
        for expression in required:
            with self.subTest(expression=expression):
                self.assertIn(expression, self.frontend)

    def test_html_escape_helper_handles_all_dynamic_text(self):
        self.assertIn("function escapeHtml(s)", self.app)
        self.assertIn("String(s ?? '').replace", self.app)
        self.assertIn("escapeHtml(ROLE_NAME[role] || role || '未知身份')", self.app)

    def test_forum_body_renderer_escapes_all_parsed_content(self):
        render_forum = re.search(
            r"function renderForumContent\(content\) \{(?P<body>.*?)\n\}\n\nfunction renderToc",
            self.app,
            re.S,
        ).group("body")
        self.assertIn("escapeHtml(l)", render_forum)
        self.assertIn("escapeHtml(c.name)", render_forum)
        self.assertNotRegex(render_forum, r"<p>\$\{l\}</p>")

    def test_avatar_values_are_filtered_before_html_or_css(self):
        self.assertIn("function safeAvatarDataUrl(value)", self.frontend)
        self.assertNotIn("background:url('${u.avatar_url}')", self.frontend)
        self.assertNotIn("background-image:url('${c.avatar}')", self.frontend)

    def test_user_strings_are_not_embedded_in_inline_handlers(self):
        dangerous = [
            "JSON.stringify(sc.name)",
            "JSON.stringify(n.title)",
            "'${escapeHtml(sc.name)}'",
        ]
        for expression in dangerous:
            with self.subTest(expression=expression):
                self.assertNotIn(expression, self.frontend)

    def test_script_csp_has_no_inline_or_eval_escape_hatch(self):
        csp = re.search(r'Content-Security-Policy" content="([^"]+)', self.html).group(1)
        script_policy = next(part.strip() for part in csp.split(';')
                             if part.strip().startswith('script-src'))
        self.assertEqual(script_policy, "script-src 'self'")
        self.assertNotRegex(self.frontend, r"\son(?:click|change|input|pointerdown|touchstart)=")
        self.assertNotRegex(self.events, r"\beval\s*\(")
        self.assertNotIn("new Function", self.events)

    def test_img_src_allows_blob_and_data_for_avatar_cropping(self):
        # The avatar crop flow loads the picked file via URL.createObjectURL (a blob: URL) and stores
        # the result as a data: URL. img-src must permit both, or cropping breaks with 圖片讀取失敗.
        csp = re.search(r'Content-Security-Policy" content="([^"]+)', self.html).group(1)
        img_policy = next(part.strip() for part in csp.split(';')
                          if part.strip().startswith('img-src'))
        self.assertIn('blob:', img_policy)
        self.assertIn('data:', img_policy)

    def test_javascript_and_styles_are_external_files(self):
        self.assertIn('<script src="./app.js" defer></script>', self.html)
        self.assertIn('<script src="./safe-events.js" defer></script>', self.html)
        self.assertNotRegex(self.html, r"<script(?:\s[^>]*)?>\s*(?!</script>)")
        self.assertIn('<link rel="stylesheet" href="./styles.css" />', self.html)

    def test_every_declarative_handler_calls_an_allowlisted_action(self):
        handlers = re.findall(
            r'data-on(?:click|change|input|pointerdown|touchstart)="([^"]*)"',
            self.frontend,
        )
        self.assertGreater(len(handlers), 100)
        for handler in handlers:
            if handler == "${open}":  # runtime value is viewUserNovels('<uuid>')
                continue
            for statement in filter(None, (part.strip() for part in handler.split(';'))):
                if (statement == "return false" or statement.startswith("event.") or
                        statement.startswith("this.") or statement.startswith("document.")):
                    continue
                call = re.match(r"^([A-Za-z_$][\w$]*)\(", statement)
                self.assertIsNotNone(call, f"Unsupported handler statement: {statement}")
                self.assertIn(f"'{call.group(1)}'", self.events)

    def test_bare_identifier_handler_arguments_are_allowlisted(self):
        # safe-events resolves a bare-identifier argument (e.g. a callback like renderAdminNovels)
        # via window[token] ONLY if it's in ALLOWED_ACTIONS — otherwise parseArgument throws and the
        # whole handler silently does nothing. Guard that every such argument is allowlisted.
        literals = {"true", "false", "null", "event", "this"}
        handlers = re.findall(
            r'data-on(?:click|change|input|pointerdown|touchstart)="([^"]*)"',
            self.frontend,
        )
        for handler in handlers:
            for statement in filter(None, (p.strip() for p in handler.split(";"))):
                m = re.match(r"^[A-Za-z_$][\w$]*\((.*)\)$", statement, re.S)
                if not m:
                    continue
                for arg in m.group(1).split(","):
                    arg = arg.strip()
                    if re.fullmatch(r"[A-Za-z_$][\w$]*", arg) and arg not in literals:
                        self.assertIn(
                            f"'{arg}'", self.events,
                            f"bare-identifier handler arg not in ALLOWED_ACTIONS: {arg} (in {statement})",
                        )

    def test_app_and_service_worker_versions_match(self):
        worker = (Path(__file__).parents[1] / "service-worker.js").read_text(encoding="utf-8")
        app_version = re.search(r"APP_VERSION = '(v[\d.]+)'", self.app).group(1)
        cache_version = re.search(r"prophet-daily-(v[\d.]+)", worker).group(1)
        self.assertEqual(app_version, cache_version)
