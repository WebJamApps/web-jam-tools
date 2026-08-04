"""Shared human-only credentials detector (web-jam-tools#344).

Reads tool execution input from stdin (JSON payload passed to PreToolUse hooks)
and checks for registered human-only credentials from hooks/human-only-credentials.yaml.

Exit code 2: if a human-only credential is being exported or stored in env files,
shell profiles, or config files.
Exit code 0: if allowed or not matching.
"""
import json
import os
import re
import sys


def load_human_only_credentials(yaml_path: str) -> list[dict]:
    if not os.path.exists(yaml_path):
        return []
    try:
        import yaml

        with open(yaml_path, "r", encoding="utf-8") as f:
            data = yaml.safe_load(f)
            if isinstance(data, dict) and "human_only_credentials" in data:
                return data["human_only_credentials"] or []
    except Exception:
        pass

    # Fallback YAML parsing if PyYAML is unavailable or fails
    creds = []
    with open(yaml_path, "r", encoding="utf-8") as f:
        current = {}
        for line in f:
            line = line.strip()
            if line.startswith("- name:"):
                if current.get("identifier"):
                    creds.append(current)
                current = {"name": line.split(":", 1)[1].strip().strip("\"'")}
            elif line.startswith("identifier:"):
                current["identifier"] = line.split(":", 1)[1].strip().strip("\"'")
            elif line.startswith("description:"):
                current["description"] = line.split(":", 1)[1].strip().strip("\"'")
        if current.get("identifier"):
            creds.append(current)
    return creds


def is_doc_or_markdown(file_path: str, cmd: str) -> bool:
    file_path_lower = file_path.lower()
    if file_path_lower:
        base = os.path.basename(file_path_lower)
        if file_path_lower.endswith(".md") or file_path_lower.endswith(".txt"):
            return True
        if "/docs/" in file_path_lower or file_path_lower.startswith("docs/") or "docs/" in file_path_lower:
            return True
        if "/skills/" in file_path_lower or file_path_lower.startswith("skills/") or "skills/" in file_path_lower:
            return True
        if "/test/" in file_path_lower or file_path_lower.startswith("test/") or "test/" in file_path_lower:
            return True
        if base in [
            "agents.md",
            "claude.md",
            "human-only-credentials.yaml",
            "block-human-only-credentials.sh",
            "detect_human_only_credentials.py",
            "josh-manual-controls.md",
            "cross-ai-rules.md",
        ]:
            return True

    if cmd:
        cmd_lower = cmd.lower()
        if re.search(r"\b(docs|skills|test)/[^\s'\"]+\.(md|txt|ts|py|yaml|sh)\b", cmd_lower):
            if not re.search(r"\.(bashrc|zshrc|env)\b", cmd_lower):
                return True
        if re.search(
            r"\b(agents\.md|claude\.md|josh-manual-controls\.md|cross-ai-rules\.md|human-only-credentials\.yaml)\b",
            cmd_lower,
        ):
            if not re.search(r"\.(bashrc|zshrc|env)\b", cmd_lower):
                return True
    return False


def is_blocked_context(target_file: str, cmd: str, identifier: str) -> bool:
    target_lower = target_file.lower()
    cmd_lower = cmd.lower()
    ident_lower = identifier.lower()

    if target_lower:
        base = os.path.basename(target_lower)
        if base in [".bashrc", ".zshrc", ".bash_profile", ".profile"]:
            return True
        if base == ".env" or base.startswith(".env."):
            return True
        if base != "human-only-credentials.yaml" and (
            base.endswith(".json")
            or base.endswith(".yaml")
            or base.endswith(".yml")
            or base.endswith(".toml")
        ):
            return True

    if cmd_lower:
        if re.search(r"\bexport\s+.*" + re.escape(ident_lower), cmd_lower):
            return True
        if re.search(r"\b[a-z0-9_]+\s*=\s*['\"]?.*" + re.escape(ident_lower), cmd_lower):
            return True
        if re.search(r"\bset\s+.*" + re.escape(ident_lower), cmd_lower):
            return True
        if re.search(r"\.(bashrc|zshrc|env)(\.|\s|$|['\"])", cmd_lower) and ident_lower in cmd_lower:
            return True
        if (
            re.search(r"\.(json|yaml|yml|toml)(['\"]?\s|$)", cmd_lower)
            and "human-only-credentials.yaml" not in cmd_lower
            and ident_lower in cmd_lower
        ):
            return True

    if target_lower and not is_doc_or_markdown(target_file, cmd):
        base = os.path.basename(target_lower)
        if (
            base in [".bashrc", ".zshrc", ".bash_profile", ".profile"]
            or base == ".env"
            or base.startswith(".env.")
            or (
                base.endswith(".json")
                or base.endswith(".yaml")
                or base.endswith(".yml")
                or base.endswith(".toml")
            )
        ):
            return True

    return False


def main():
    hook_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    yaml_path = os.path.join(hook_dir, "human-only-credentials.yaml")
    creds = load_human_only_credentials(yaml_path)
    if not creds:
        sys.exit(0)

    try:
        raw_input = sys.stdin.read()
        if not raw_input.strip():
            sys.exit(0)
        data = json.loads(raw_input)
    except Exception:
        sys.exit(0)

    tool_input = data.get("tool_input") or data.get("input") or data.get("arguments") or {}
    if not isinstance(tool_input, dict):
        tool_input = {}

    cmd = tool_input.get("command") or tool_input.get("CommandLine") or ""
    file_path = (
        tool_input.get("file_path")
        or tool_input.get("path")
        or tool_input.get("TargetFile")
        or tool_input.get("target_file")
        or ""
    )
    content = (
        tool_input.get("content")
        or tool_input.get("CodeContent")
        or tool_input.get("new_string")
        or tool_input.get("ReplacementContent")
        or tool_input.get("replacementContent")
        or ""
    )
    if not content and "ReplacementChunks" in tool_input:
        content = json.dumps(tool_input.get("ReplacementChunks"))

    blob = f"{cmd}\n{file_path}\n{content}\n{json.dumps(tool_input)}"
    blob_lower = blob.lower()

    for entry in creds:
        ident = entry.get("identifier", "").strip()
        name = entry.get("name", "").strip()
        if not ident:
            continue

        if ident.lower() in blob_lower:
            if is_doc_or_markdown(file_path, cmd):
                continue

            if is_blocked_context(file_path, cmd, ident):
                print(
                    f"BLOCKED (human-only-credentials guard): attempted to export or store registered human-only credential '{ident}' ({name}).",
                    file=sys.stderr,
                )
                print(
                    "Human-consumed credentials belong in KeePass only and must not be stored in environment files, shell profiles, or configuration files.",
                    file=sys.stderr,
                )
                print("(rule: web-jam-tools#344 — human-only-credentials-register)", file=sys.stderr)
                sys.exit(2)

    sys.exit(0)


if __name__ == "__main__":
    main()
