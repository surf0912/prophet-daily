#!/usr/bin/env python3
"""一鍵同步版本號 —— 同時改 app.js 的 APP_VERSION 與 service-worker.js 的 CACHE_NAME。

兩處必須一致（自我修復邏輯靠比對這兩個），手動分開改容易忘一個。用這支就不會漏。

用法：
    python3 tools/bump.py            # 次號 +1、滿 100 進位主號（v3.103 → v4.04；v4.99 → v5.00）
    python3 tools/bump.py 2.95       # 指定版本
    python3 tools/bump.py v2.95      # v 前綴可有可無
    python3 tools/bump.py --check    # 只檢查兩處是否一致，不改

改完會印出兩處版本並確認一致。
"""
import re
import sys
import os

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APP = os.path.join(REPO, "app.js")
SW = os.path.join(REPO, "service-worker.js")


def read_versions():
    a = re.search(r"APP_VERSION = 'v([\d.]+)'", open(APP).read())
    s = re.search(r"prophet-daily-v([\d.]+)", open(SW).read())
    return (a.group(1) if a else None), (s.group(1) if s else None)


def set_version(newv):
    a = open(APP).read()
    open(APP, "w").write(re.sub(r"APP_VERSION = 'v[\d.]+'", f"APP_VERSION = 'v{newv}'", a, count=1))
    s = open(SW).read()
    open(SW, "w").write(re.sub(r"prophet-daily-v[\d.]+", f"prophet-daily-v{newv}", s, count=1))


def main():
    arg = sys.argv[1] if len(sys.argv) > 1 else None
    av, sv = read_versions()
    if arg == "--check":
        print(f"  APP_VERSION=v{av}  CACHE=v{sv}  → {'✓ 一致' if av == sv else '✗ 不一致！'}")
        sys.exit(0 if av == sv else 1)
    if arg:
        newv = arg.lstrip("v")
    else:
        parts = (av or "0.0").split(".")
        major, minor = int(parts[0]), int(parts[1])
        minor += 1
        if minor >= 100:            # 次號滿 100 → 進位主號、次號歸零（v4.99 → v5.00）
            major += minor // 100
            minor %= 100
        newv = f"{major}.{minor:02d}"   # 次號固定兩位數（v4.04，不是 v4.4）
    set_version(newv)
    av2, sv2 = read_versions()
    ok = av2 == sv2 == newv
    print(f"  v{av} → v{newv}")
    print(f"  APP_VERSION=v{av2}  CACHE=v{sv2}  → {'✓ 一致' if ok else '✗ 不一致！'}")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
