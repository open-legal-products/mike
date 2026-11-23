"""Independent, offline cp-rwp-json-v1 verification from serialized bytes.

This implementation follows the pinned public contract, not producer code.
Unkeyed consistency is never author authentication or a factual-truth verdict.
"""
from __future__ import annotations

import argparse
import base64
import binascii
from decimal import Decimal, InvalidOperation, ROUND_DOWN
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import unicodedata
from typing import Any

from .research_workspace_schema import SchemaViolation, native_context_card_page, validate_research_workspace

SCHEMA = "counterpedia.research_workspace.portable_pack.v0.2"
CANONICALIZATION = "cp-rwp-json-v1"
MAX_BYTES = 4_194_304
MAX_NODES = 200_000
MAX_DEPTH = 64
MAX_INTEGER = 9_007_199_254_740_991
REVISION_DOMAIN = b"counterpedia.research_workspace.portable_revision.v0.2\0"
EXPORT_DOMAIN = b"counterpedia.research_workspace.portable_export.v0.2\0"
CONTRACT_AUTHORITY = {
    "repository": "thelaplage/counterpedia",
    "commit": "fda49b9ab3d229107297d4573237b0447fedb654",
    "path": "docs/research/RESEARCH_WORKSPACE_PORTABLE_V02.md",
    "sha256": "3d6fdecb65b33144a95ebd69082268939ad8fe12e6166d409ac65c7f6d140050",
}
CONTEXT_CARD_PROFILE = "v0.2-entry-source-card-context"
# Exact canonical owner-approved amendment; legacy authority remains unchanged.
CONTEXT_CARD_AUTHORITY = {
    "repository": "thelaplage/counterpedia",
    "commit": "bd7299081c42255a09997958c5004ba8e3075434",
    "path": "docs/research/RESEARCH_WORKSPACE_PORTABLE_V02.md",
    "sha256": "16c44eb159e6f2cc0e8bee0a3f4256dc9abb8976e20ff3e9d7699fcb4bb7864f",
}
_KEY = re.compile(r"[a-z][a-z0-9_]*\Z", re.ASCII)
_NUMBER = re.compile(r"-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE]([+-]?)([0-9]+))?\Z", re.ASCII)
# ECMAScript whitespace is not Python's ASCII \s. Keep ASCII word boundaries
# while spelling out the contract's whitespace set in each affected position.
_SPACE_CHARS = r"\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
_SPACE = "[" + _SPACE_CHARS + "]"
_NONSPACE = "[^" + _SPACE_CHARS + "]"
_SENSITIVE_SHAPES = (
    (r"\bBearer" + _SPACE + r"+[A-Za-z0-9._~+/=-]{16,}", re.I),
    (r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}", 0),
    (r"\b(?:sk|pk|rk|ghp|gho|ghs|xox[abp])[-_][A-Za-z0-9_-]{16,}", re.I),
    (r"\bgithub_pat_[A-Za-z0-9_]{16,}", re.I),
    (r"\bglpat-[A-Za-z0-9_-]{16,}", re.I),
    (r"\bAIza[0-9A-Za-z_-]{30,}", 0),
    (r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b", 0),
    (r"-----BEGIN [A-Z ]*PRIVATE KEY-----", 0),
    (r"://[^/" + _SPACE_CHARS + r":@]+:[^/" + _SPACE_CHARS + r"@]+@", 0),
    (r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}", 0),
    (r"(?:secret|password|passwd|pwd|passphrase|token|cookie|authorization|session[_-]?id|key)[\"']?" + _SPACE + "*[:=]" + _SPACE + "*" + _NONSPACE + "{8,}", re.I),
)


def _screen_text(text: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFKC", text) if unicodedata.category(c) != "Cf")


def _listed_sensitive_shape(text: str) -> bool:
    """Pinned deny-list only; cannot prove absence of arbitrary private data."""
    normalized = _screen_text(text)
    patterns = [re.compile(pattern, flags | re.ASCII) for pattern, flags in _SENSITIVE_SHAPES]
    if any(pattern.search(normalized) for pattern in patterns):
        return True
    for match in re.finditer(r"[A-Za-z0-9+/_-]{40,}={0,2}", normalized, re.ASCII):
        run = match.group().rstrip("=").replace("-", "+").replace("_", "/")
        # Match the pinned permissive base64 decoding: incomplete trailing six
        # bits cannot encode an octet. No recursive decoding is performed.
        if len(run) % 4 == 1:
            run = run[:-1]
        try:
            decoded = base64.b64decode(run + "=" * (-len(run) % 4)).decode("utf-8", "replace")
        except binascii.Error:
            continue
        if any(pattern.search(_screen_text(decoded)) for pattern in patterns):
            return True
    return False


class WorkspaceInputError(ValueError):
    def __init__(self, code: str, path: str = "$") -> None:
        self.code = code
        self.path = path
        super().__init__(code)


def _integer_token(token: str) -> int:
    # Decimal parses the original coefficient exactly; no binary float is ever
    # constructed. Check bounded exponent and magnitude before integral conversion.
    match = _NUMBER.fullmatch(token)
    if len(token) > 1024 or match is None:
        raise WorkspaceInputError("research_workspace.numeric_token_invalid")
    exponent = (match.group(2) or "0").lstrip("0") or "0"
    if len(exponent) > 6 or int(exponent) > 999_999:
        raise WorkspaceInputError("research_workspace.numeric_token_invalid")
    try:
        value = Decimal(token)
        if value.is_zero():
            if value.is_signed():
                raise WorkspaceInputError("research_workspace.negative_zero")
            return 0
        if not value.is_finite() or value.adjusted() > 15 or value.adjusted() < 0:
            raise WorkspaceInputError("research_workspace.numeric_token_invalid")
        if value != value.to_integral_value(rounding=ROUND_DOWN) or value.copy_abs() > MAX_INTEGER:
            raise WorkspaceInputError("research_workspace.numeric_token_invalid")
        return int(value)
    except InvalidOperation as exc:
        raise WorkspaceInputError("research_workspace.numeric_token_invalid") from exc


def _pairs(items: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in items:
        if key in result:
            raise WorkspaceInputError("research_workspace.duplicate_json_member")
        result[key] = value
    return result


def _constant(_token: str) -> Any:
    raise WorkspaceInputError("research_workspace.non_json_number")


def canonical_workspace_json(value: Any) -> bytes:
    """Canonical UTF-8 bytes: ASCII-sorted keys, scalar strings, exact integers.

    Python's Unicode-aware JSON encoder uses the same required short C0 escapes
    and literal non-ASCII scalars here. No Unicode normalization is applied.
    """
    nodes = 0
    active: set[int] = set()

    def walk(item: Any, depth: int) -> str:
        nonlocal nodes
        nodes += 1
        if nodes > MAX_NODES or depth > MAX_DEPTH:
            raise WorkspaceInputError("research_workspace.complexity_limit")
        if item is None:
            return "null"
        if type(item) is bool:
            return "true" if item else "false"
        if type(item) is int:
            if abs(item) > MAX_INTEGER:
                raise WorkspaceInputError("research_workspace.numeric_value_invalid")
            return str(item)
        if type(item) is str:
            if any(ord(c) == 0 or 0xD800 <= ord(c) <= 0xDFFF for c in item):
                raise WorkspaceInputError("research_workspace.unicode_invalid")
            return json.dumps(item, ensure_ascii=False, separators=(",", ":"))
        if type(item) not in (dict, list):
            raise WorkspaceInputError("research_workspace.value_invalid")
        identity = id(item)
        if identity in active:
            raise WorkspaceInputError("research_workspace.cycle")
        active.add(identity)
        try:
            if type(item) is list:
                return "[" + ",".join(walk(child, depth + 1) for child in item) + "]"
            if any(type(key) is not str or not _KEY.fullmatch(key) for key in item):
                raise WorkspaceInputError("research_workspace.object_key_invalid")
            return "{" + ",".join(
                json.dumps(key) + ":" + walk(item[key], depth + 1)
                for key in sorted(item)
            ) + "}"
        finally:
            active.remove(identity)

    try:
        encoded = walk(value, 0).encode("utf-8", "strict")
    except RecursionError as exc:
        raise WorkspaceInputError("research_workspace.complexity_limit") from exc
    if len(encoded) > MAX_BYTES:
        raise WorkspaceInputError("research_workspace.too_large")
    return encoded


def parse_workspace_json(data: bytes) -> dict[str, Any]:
    if type(data) is not bytes:
        raise WorkspaceInputError("research_workspace.bytes_required")
    if len(data) > MAX_BYTES:
        raise WorkspaceInputError("research_workspace.too_large")
    try:
        value = json.loads(
            data.decode("utf-8", "strict"), object_pairs_hook=_pairs,
            parse_int=_integer_token, parse_float=_integer_token,
            parse_constant=_constant,
        )
    except WorkspaceInputError:
        raise
    except (UnicodeError, json.JSONDecodeError, ValueError) as exc:
        raise WorkspaceInputError("research_workspace.json_invalid") from exc
    except RecursionError as exc:
        raise WorkspaceInputError("research_workspace.complexity_limit") from exc
    canonical_workspace_json(value)
    if type(value) is not dict:
        raise WorkspaceInputError("research_workspace.object_required")
    return value


def _hash(domain: bytes, value: Any) -> str:
    return "sha256:" + hashlib.sha256(domain + canonical_workspace_json(value)).hexdigest()


def _empty_report(data: Any) -> dict[str, Any]:
    return {
        "schema": "arcs.verify.research_workspace_report.v0.1",
        "contract": SCHEMA,
        "canonicalization": CANONICALIZATION,
        "contract_authority": dict(CONTRACT_AUTHORITY),
        "input_sha256": hashlib.sha256(data).hexdigest() if type(data) is bytes and len(data) <= MAX_BYTES else None,
        "integrity": "fail",
        "lineage": {"status": "not_evaluated", "revision_count": 0, "head_sha256": None},
        "export_envelope": {"status": "not_evaluated", "sha256": None},
        "unsupported_references": [],
        "authenticity": "not_established",
        "factual_truth": "not_evaluated",
        "source_currentness": "not_evaluated",
        "disclosure_rights": "not_evaluated",
        "failures": [],
    }


def verify_research_workspace_bytes(data: bytes) -> dict[str, Any]:
    report = _empty_report(data)
    try:
        document = parse_workspace_json(data)
        unsupported = validate_research_workspace(document)
        if any(
            native_context_card_page(item["claimed_metadata"]["page"])
            for revision in document["revisions"]
            for item in [*revision["context_selection"]["items"], *revision["research_context"]]
        ):
            report["contract_authority"] = dict(CONTEXT_CARD_AUTHORITY)
            report["contract_profile"] = CONTEXT_CARD_PROFILE
        if _listed_sensitive_shape(canonical_workspace_json(document).decode("utf-8")):
            raise WorkspaceInputError("research_workspace.credential_shape")
        revisions = document["revisions"]
        report["lineage"]["revision_count"] = len(revisions)
        report["lineage"]["status"] = "fail"
        parent = None
        for index, revision in enumerate(revisions):
            path = f"$.revisions[{index}]"
            if revision["parent_portable_revision_sha256"] != parent:
                raise WorkspaceInputError("research_workspace.parent_mismatch", path)
            unsigned = {key: value for key, value in revision.items() if key != "portable_revision_sha256"}
            computed = _hash(REVISION_DOMAIN, unsigned)
            if revision["portable_revision_sha256"] != computed:
                raise WorkspaceInputError("research_workspace.revision_hash_mismatch", path)
            parent = computed
        report["lineage"].update(status="pass", head_sha256=parent)
        report["export_envelope"]["status"] = "fail"
        envelope = document["export"]
        if envelope["head_portable_revision_sha256"] != parent:
            raise WorkspaceInputError("research_workspace.export_head_mismatch", "$.export")
        computed = _hash(EXPORT_DOMAIN, {key: value for key, value in envelope.items() if key != "export_sha256"})
        if envelope["export_sha256"] != computed:
            raise WorkspaceInputError("research_workspace.export_hash_mismatch", "$.export")
        report["export_envelope"].update(status="pass", sha256=computed)
        report["unsupported_references"] = unsupported
        report["integrity"] = "pass"
    except (WorkspaceInputError, SchemaViolation) as exc:
        report["failures"].append({"code": exc.code, "path": exc.path})
    except (KeyError, TypeError, IndexError, ValueError, OverflowError, RecursionError):
        # Malformed serialized inputs must never become a traceback or a PASS.
        report["failures"].append({"code": "research_workspace.shape_invalid", "path": "$"})
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="arcs-verify research-workspace",
        description="Independently check portable Research integrity offline; never authenticate authorship.",
    )
    parser.add_argument("pack", type=Path, help="local UTF-8 Research Pack JSON")
    parser.add_argument("--json", action="store_true", help="machine-readable JSON (always enabled)")
    args = parser.parse_args(argv)
    try:
        # A named pipe/device must not block opening an untrusted artifact.
        # Validate the opened descriptor, not a racy pathname stat followed by open.
        descriptor = os.open(args.pack, os.O_RDONLY | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_BINARY", 0))
        with os.fdopen(descriptor, "rb") as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode):
                raise WorkspaceInputError("research_workspace.input_not_regular")
            if info.st_size > MAX_BYTES:
                raise WorkspaceInputError("research_workspace.too_large")
            data = stream.read(MAX_BYTES + 1)
        report = verify_research_workspace_bytes(data)
    except WorkspaceInputError as exc:
        report = _empty_report(None)
        report["failures"].append({"code": exc.code, "path": exc.path})
    except OSError:
        report = _empty_report(None)
        report["failures"].append({"code": "research_workspace.input_unreadable", "path": "$"})
    print(json.dumps(report, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
    return 0 if report["integrity"] == "pass" else 1


if __name__ == "__main__":
    sys.exit(main())
