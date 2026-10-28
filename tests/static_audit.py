#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""静态审计脚本（QA）：可加载性 / CSP / 引用完整性 / 导入导出一致性。

不修改产品代码，只读扫描。用法：
    python tests/static_audit.py
退出码：0 全部通过；1 存在 FAIL 项。
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

RESULTS: list[tuple[str, str, str]] = []  # (level, item, detail)


def record(level: str, item: str, detail: str = "") -> None:
    RESULTS.append((level, item, detail))


def read(path: str) -> str:
    with open(os.path.join(ROOT, path), "r", encoding="utf-8") as handle:
        return handle.read()


def exists(path: str) -> bool:
    return os.path.isfile(os.path.join(ROOT, path))


# --------------------------------------------------------------------------- #
# 1. manifest.json
# --------------------------------------------------------------------------- #
ALLOWED_MANIFEST_KEYS = {
    "manifest_version", "name", "version", "description", "default_locale",
    "icons", "action", "background", "chrome_url_overrides", "permissions",
    "host_permissions", "optional_permissions", "optional_host_permissions",
    "content_scripts", "web_accessible_resources", "content_security_policy",
    "options_page", "options_ui", "commands", "omnibox", "side_panel",
    "minimum_chrome_version", "author", "homepage_url", "short_name",
    "storage", "tts_engine", "sandbox", "devtools_page", "externally_connectable",
}
VALID_PERMISSIONS = {
    "storage", "unlimitedStorage", "tabs", "bookmarks", "history", "downloads",
    "clipboardRead", "clipboardWrite", "notifications", "contextMenus",
    "alarms", "cookies", "scripting", "activeTab", "webRequest",
    "webRequestBlocking", "management", "sessions", "topSites", "favicon",
    "geolocation", "identity", "idle", "power", "printerProvider",
    "unlimited_storage_placeholder",
}


def audit_manifest() -> None:
    try:
        manifest = json.loads(read("manifest.json"))
    except Exception as exc:  # noqa: BLE001
        record("FAIL", "manifest.json 可解析", f"JSON 解析失败：{exc}")
        return
    record("PASS", "manifest.json 可解析")

    if manifest.get("manifest_version") != 3:
        record("FAIL", "manifest_version = 3", f"实际为 {manifest.get('manifest_version')!r}")
    else:
        record("PASS", "manifest_version = 3")

    for key in ("name", "version", "description"):
        if isinstance(manifest.get(key), str) and manifest[key].strip():
            record("PASS", f"manifest 必填字段 {key}")
        else:
            record("FAIL", f"manifest 必填字段 {key}", "缺失或为空")

    unknown = set(manifest) - ALLOWED_MANIFEST_KEYS
    if unknown:
        record("FAIL", "manifest 无非法字段", f"未知字段：{sorted(unknown)}")
    else:
        record("PASS", "manifest 无非法字段")

    overrides = manifest.get("chrome_url_overrides") or {}
    newtab = overrides.get("newtab")
    if not newtab:
        record("FAIL", "chrome_url_overrides.newtab 已声明")
    elif not exists(newtab):
        record("FAIL", "chrome_url_overrides.newtab 指向存在的文件", f"{newtab} 不存在")
    else:
        record("PASS", "chrome_url_overrides.newtab 指向存在的文件", newtab)

    perms = manifest.get("permissions") or []
    bad = [p for p in perms if p not in VALID_PERMISSIONS]
    if bad:
        record("FAIL", "permissions 拼写合法", f"未识别：{bad}")
    else:
        record("PASS", "permissions 拼写合法", str(perms))

    hosts = manifest.get("host_permissions") or []
    bad_hosts = [h for h in hosts if not re.match(r"^(\*|https?|file|ftp)://", h) and h != "<all_urls>"]
    if bad_hosts:
        record("FAIL", "host_permissions 格式合法", f"异常：{bad_hosts}")
    else:
        record("PASS", "host_permissions 格式合法", str(hosts))

    # icons 若声明必须存在
    icons = manifest.get("icons") or {}
    missing = [v for v in icons.values() if not exists(v.lstrip("/"))]
    if missing:
        record("FAIL", "manifest.icons 引用文件存在", f"缺失：{missing}")
    else:
        record("PASS", "manifest.icons 引用文件存在", f"{len(icons)} 个（或未声明）")

    # background service worker 若声明必须存在
    bg = manifest.get("background") or {}
    worker = bg.get("service_worker")
    if worker and not exists(worker):
        record("FAIL", "background.service_worker 指向存在的文件", worker)
    else:
        record("PASS", "background 字段一致性", worker or "未声明（README 明确说明无 SW）")


# --------------------------------------------------------------------------- #
# 2. HTML 引用完整性
# --------------------------------------------------------------------------- #
def audit_html_refs() -> None:
    html = read("newtab.html")
    refs = re.findall(r'(?:href|src)\s*=\s*"([^"]+)"', html)
    local = [r for r in refs if not re.match(r"^(https?:|data:|#|mailto:)", r)]
    missing = [r for r in local if not exists(r.lstrip("./"))]
    if missing:
        record("FAIL", "newtab.html 引用的本地资源存在", f"缺失：{missing}")
    else:
        record("PASS", "newtab.html 引用的本地资源存在", f"{len(local)} 个：{local}")

    # 每个 id 在 JS 中被 getElementById 引用时，HTML 中必须存在
    ids_in_html = set(re.findall(r'id="([^"]+)"', html))
    js_ids = set()
    for dirpath, _dirnames, filenames in os.walk(os.path.join(ROOT, "src")):
        for name in filenames:
            if not name.endswith(".js"):
                continue
            with open(os.path.join(dirpath, name), "r", encoding="utf-8") as handle:
                content = handle.read()
            js_ids |= set(re.findall(r"getElementById\('([^']+)'\)", content))
    missing_ids = sorted(js_ids - ids_in_html)
    if missing_ids:
        record("FAIL", "JS 中 getElementById 的 id 均存在于 HTML", f"缺失：{missing_ids}")
    else:
        record("PASS", "JS 中 getElementById 的 id 均存在于 HTML", f"{len(js_ids)} 个")


# --------------------------------------------------------------------------- #
# 3. CSS 引用完整性
# --------------------------------------------------------------------------- #
def audit_css_refs() -> None:
    missing = []
    for name in ("base.css", "layout.css", "panels.css"):
        css = read(os.path.join("styles", name))
        for raw in re.findall(r"url\(([^)]+)\)", css):
            value = raw.strip().strip("\"'")
            if re.match(r"^(data:|https?:|#)", value):
                continue
            if not exists(value.lstrip("./")):
                missing.append((name, value))
        for raw in re.findall(r"@import\s+[\"']([^\"']+)[\"']", css):
            if not exists(raw.lstrip("./")):
                missing.append((name, raw))
    if missing:
        record("FAIL", "CSS 外部资源引用存在", str(missing))
    else:
        record("PASS", "CSS 外部资源引用存在（仅内联 data URI）")

    # JS 设置的 CSS 变量必须在 CSS 中被消费
    layout = read(os.path.join("styles", "layout.css"))
    for var in ("--bg-blur", "--bg-dim"):
        if var in layout:
            record("PASS", f"CSS 变量 {var} 被消费")
        else:
            record("FAIL", f"CSS 变量 {var} 被消费", "JS 设置了但 CSS 未使用")


# --------------------------------------------------------------------------- #
# 4. CSP 合规扫描
# --------------------------------------------------------------------------- #
def audit_csp() -> None:
    js_files = []
    for dirpath, _dirnames, filenames in os.walk(os.path.join(ROOT, "src")):
        for name in filenames:
            if name.endswith(".js"):
                js_files.append(os.path.join(dirpath, name))

    hits: dict[str, list[str]] = {
        "eval(": [], "new Function": [], "javascript:": [],
        "document.write": [], "setTimeout(\"": [],
    }
    for path in js_files:
        rel = os.path.relpath(path, ROOT).replace("\\", "/")
        with open(path, "r", encoding="utf-8") as handle:
            content = handle.read()
        for token in hits:
            for index, line in enumerate(content.splitlines(), 1):
                if token in line and not line.strip().startswith("*"):
                    hits[token].append(f"{rel}:{index}")

    for token, where in hits.items():
        if where:
            record("FAIL", f"无 {token}", str(where))
        else:
            record("PASS", f"无 {token}")

    html = read("newtab.html")
    inline_script = re.findall(r"<script(?![^>]*\bsrc=)[^>]*>", html)
    if inline_script:
        record("FAIL", "无内联 <script>", str(inline_script))
    else:
        record("PASS", "无内联 <script>")

    inline_attr = re.findall(r"\son[a-z]+\s*=\s*[\"']", html)
    if inline_attr:
        record("FAIL", "无内联事件属性", str(inline_attr))
    else:
        record("PASS", "无内联事件属性")

    # innerHTML 赋值点人工复核清单（只统计，不判定）
    sites = []
    for path in js_files:
        rel = os.path.relpath(path, ROOT).replace("\\", "/")
        with open(path, "r", encoding="utf-8") as handle:
            for index, line in enumerate(handle.read().splitlines(), 1):
                if ".innerHTML" in line and "=" in line:
                    sites.append(f"{rel}:{index}")
    record("INFO", f"innerHTML 赋值点 {len(sites)} 处（需逐个人工复核转义）", ", ".join(sites))


# --------------------------------------------------------------------------- #
# 5. ES Module 导入 / 导出一致性
# --------------------------------------------------------------------------- #
def collect_exports(content: str) -> set[str]:
    names: set[str] = set()
    names |= set(re.findall(r"export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)", content))
    names |= set(re.findall(r"export\s+class\s+([A-Za-z_$][\w$]*)", content))
    names |= set(re.findall(r"export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)", content))
    for group in re.findall(r"export\s*\{([^}]*)\}", content):
        for part in group.split(","):
            piece = part.strip()
            if not piece:
                continue
            alias = piece.split(" as ")[-1].strip()
            names.add(alias)
    if re.search(r"export\s+default", content):
        names.add("default")
    return names


def audit_imports() -> None:
    js_files = []
    for dirpath, _dirnames, filenames in os.walk(os.path.join(ROOT, "src")):
        for name in filenames:
            if name.endswith(".js"):
                js_files.append(os.path.join(dirpath, name))

    problems = []
    checked = 0
    for path in js_files:
        rel = os.path.relpath(path, ROOT).replace("\\", "/")
        folder = os.path.dirname(path)
        with open(path, "r", encoding="utf-8") as handle:
            content = handle.read()

        for match in re.finditer(r"import\s+(?:([\w$]+)\s*,\s*)?(?:\{([^}]*)\}|\*\s+as\s+([\w$]+)|([\w$]+))?\s*from\s*['\"]([^'\"]+)['\"]", content):
            spec = match.group(5)
            if not spec.startswith("."):
                continue
            target = os.path.normpath(os.path.join(folder, spec))
            if not os.path.isfile(target):
                problems.append(f"{rel}: 导入目标不存在 {spec}")
                continue
            with open(target, "r", encoding="utf-8") as handle:
                exported = collect_exports(handle.read())
            names = []
            if match.group(2):
                for part in match.group(2).split(","):
                    piece = part.strip()
                    if not piece:
                        continue
                    local = piece.split(" as ")[0].strip()
                    names.append(local)
            for name in names:
                checked += 1
                if name not in exported:
                    problems.append(
                        f"{rel}: 从 {spec} 导入的 {name} 未被导出"
                    )

    if problems:
        record("FAIL", "ES Module 具名导入与导出一致", "; ".join(problems))
    else:
        record("PASS", "ES Module 具名导入与导出一致", f"校验 {checked} 个具名导入")


# --------------------------------------------------------------------------- #
# 6. 语法检查（node --check，ESM）
# --------------------------------------------------------------------------- #
def audit_syntax() -> None:
    js_files = []
    for dirpath, _dirnames, filenames in os.walk(os.path.join(ROOT, "src")):
        for name in filenames:
            if name.endswith(".js"):
                js_files.append(os.path.join(dirpath, name))
    failures = []
    for path in js_files:
        proc = subprocess.run(
            ["node", "--input-type=module", "--check"],
            stdin=open(path, "r", encoding="utf-8"),
            capture_output=True,
            text=True,
        )
        if proc.returncode != 0:
            failures.append(f"{os.path.basename(path)}: {proc.stderr.strip()[:200]}")
    if failures:
        record("FAIL", "node --check 语法通过（ESM）", "; ".join(failures))
    else:
        record("PASS", "node --check 语法通过（ESM）", f"{len(js_files)} 个文件")


# --------------------------------------------------------------------------- #
# 7. secrets 不进入导出 + 关键常量一致性
# --------------------------------------------------------------------------- #
def audit_secrets_export() -> None:
    storage = read("src/storage.js")
    if re.search(r"export async function exportConfig", storage):
        record("PASS", "exportConfig 已实现")
    else:
        record("FAIL", "exportConfig 已实现")
        return
    block = storage[storage.index("export async function exportConfig"):]
    block = block[: block.index("\n}\n") + 1]
    if "getSecrets" in block or "secrets:" in block.replace("payload.settings", ""):
        record("FAIL", "exportConfig 不包含 secrets", "函数体内出现 secrets 引用")
    else:
        record("PASS", "exportConfig 不包含 secrets", "payload 仅 settings + sites")
    if "importConfig" in storage and "delete sanitized.secrets" in storage:
        record("PASS", "importConfig 拒绝覆盖 secrets")
    else:
        record("FAIL", "importConfig 拒绝覆盖 secrets")


def audit_versions() -> None:
    manifest = json.loads(read("manifest.json"))
    defaults = read("src/defaults.js")
    match = re.search(r"APP_VERSION\s*=\s*'([^']+)'", defaults)
    if match and match.group(1) == manifest.get("version"):
        record("PASS", "manifest.version 与 APP_VERSION 一致", match.group(1))
    else:
        record(
            "FAIL",
            "manifest.version 与 APP_VERSION 一致",
            f"manifest={manifest.get('version')} defaults={match.group(1) if match else 'N/A'}",
        )


def main() -> int:
    audit_manifest()
    audit_html_refs()
    audit_css_refs()
    audit_csp()
    audit_imports()
    audit_syntax()
    audit_secrets_export()
    audit_versions()

    fails = [row for row in RESULTS if row[0] == "FAIL"]
    infos = [row for row in RESULTS if row[0] == "INFO"]
    passes = [row for row in RESULTS if row[0] == "PASS"]

    for level, item, detail in RESULTS:
        if level == "PASS":
            continue
        print(f"[{level}] {item}" + (f" -> {detail}" if detail else ""))
    print("-" * 70)
    print(f"PASS {len(passes)} / FAIL {len(fails)} / INFO {len(infos)}")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
