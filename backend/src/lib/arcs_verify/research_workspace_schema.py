"""Independent serialized-schema checks for the pinned Research Workspace Pack.

Authority: Counterpedia fda49b9ab3d229107297d4573237b0447fedb654,
docs/research/RESEARCH_WORKSPACE_PORTABLE_V02.md and its explicitly pinned public
grammar dependencies at 88d22ec61a56fd7a618ac06db118eeb4d688e7b6.

This module imports no producer code, performs no lookup, and does not evaluate
source truth, authorship, current availability, or a right to disclose content.
Whole-artifact JSON/canonicalization and hash checking belong to the caller.
"""

from __future__ import annotations

import hashlib
import ipaddress
import json
import re
from typing import Any
from urllib.parse import parse_qsl, unquote, urlsplit


class SchemaViolation(ValueError):
    """A bounded machine-readable failure, never a copy of untrusted prose."""

    def __init__(self, code: str, path: str, reason: str = "") -> None:
        self.code = code
        self.path = path
        super().__init__(reason or code)


_PACK = "counterpedia.research_workspace.portable_pack.v0.2"
_REVISION = "counterpedia.research_workspace.portable_revision.v0.2"
_SECTION = "counterpedia.public_research_section"
_SOURCE = "counterpedia.public_source_record"
_RECORD = "counterpedia.public_record_evidence"
_PUBLIC = {_SECTION, _SOURCE, _RECORD}
_CONTROLLED = {
    "acquisition.retained_capture",
    "source_intelligence.saved_doaj_observation",
    "source_intelligence.saved_crossref_observation",
    "source_intelligence.private_connector_fetch",
    "source_intelligence.private_connector_import",
    "source_intelligence.user_search_result",
}
_BASES = {
    "current": "saved_reference_matches_current_producer_readback",
    "stale": "source_changed_since_saved",
    "unavailable": "source_not_available",
    "unreadable": "source_read_failed",
    "unsupported": "unknown_producer_family",
}
_LIMITS = [
    "source_bytes_not_included",
    "unkeyed_integrity_not_authorship",
    "current_readback_is_export_time_observation",
    "offline_copy_cannot_be_withdrawn",
]
_HASH = re.compile(r"sha256:[0-9a-f]{64}\Z", re.ASCII)
_HEX = re.compile(r"[0-9a-f]{64}\Z", re.ASCII)
_OBSERVATION = re.compile(r"ob_[0-9a-f]{24}\Z", re.ASCII)
_PROPOSITION = re.compile(r"pr_[a-z0-9]{4,32}\Z", re.ASCII)
_RECORD_PART = re.compile(r"[A-Za-z0-9._:-]{1,160}\Z", re.ASCII)
_CONTEXT_ID = re.compile(r"r(?:0[1-9]|1[0-9]|2[0-4])\Z", re.ASCII)
_CITATION_ROUTE = re.compile(r"/(?:entries|sources|records)/[a-z0-9][a-z0-9-]{0,180}\Z", re.ASCII | re.IGNORECASE)
_SOURCE_ID = re.compile(r"[A-Za-z0-9._:~-]{1,256}\Z", re.ASCII)
_SOURCE_ROUTE = re.compile(r"/sources/[A-Za-z0-9._~-]{1,200}\Z", re.ASCII)
_SOURCE_RESERVED = {".", "..", "captures", "families", "nyt-openai", "organizations"}
_FORBIDDEN_QUERY = re.compile(
    r"(?:q|query|search|account_id|workspace_id|principal|user_id|session(?:_id)?|trace(?:_id)?|request(?:_id)?|fanout_id|collection_ref|provider_query_id|entry_index|token|access_token|api_key|apikey|key|auth|authorization)\Z",
    re.ASCII | re.IGNORECASE,
)
_PRIVATE_PATH = re.compile(r"/(?:research|account|accounts|workspace|workspaces|saved|login|logout)(?:/|\Z)|/api/(?:counterpedia/)?research(?:/|\Z)", re.ASCII | re.IGNORECASE)
_WS = "\u0009\u000a\u000b\u000c\u000d \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
_ISO = re.compile(r"([0-9]{4}|[+-][0-9]{6})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})\.([0-9]{3})Z\Z", re.ASCII)


def _fail(path: str, reason: str, code: str = "schema_invalid") -> None:
    raise SchemaViolation(code, path, reason)


def _object(value: Any, names: set[str], path: str, optional: set[str] | None = None) -> dict[str, Any]:
    if type(value) is not dict:
        _fail(path, "Expected a JSON object")
    actual = set(value)
    if not names <= actual or actual - names - (optional or set()):
        _fail(path, "Missing or unknown object member")
    return value


def _array(value: Any, maximum: int, path: str, minimum: int = 0) -> list[Any]:
    if type(value) is not list or not minimum <= len(value) <= maximum:
        _fail(path, "Array cardinality is outside the contract")
    return value


def _scalar(value: Any) -> bool:
    return isinstance(value, str) and all(c != "\x00" and not 0xD800 <= ord(c) <= 0xDFFF for c in value)


def _text(value: Any, maximum: int, path: str, minimum: int = 0, *, line: bool = False, utf16: bool = False) -> str:
    if not _scalar(value):
        _fail(path, "Expected scalar Unicode text")
    size = len(value.encode("utf-16-le")) // 2 if utf16 else len(value)
    if not minimum <= size <= maximum:
        _fail(path, "Text cardinality is outside the contract")
    if line and (not value.strip(_WS) or any(ord(c) < 32 or 127 <= ord(c) <= 159 for c in value)):
        _fail(path, "Display line contains controls or only whitespace")
    return value


def _nullable(value: Any, maximum: int, path: str) -> None:
    if value is not None:
        _text(value, maximum, path)


def _match(value: Any, pattern: re.Pattern[str], path: str) -> str:
    if not isinstance(value, str) or pattern.fullmatch(value) is None:
        _fail(path, "Value does not match its exact serialized grammar")
    return value


def _integer(value: Any, low: int, high: int, path: str) -> int:
    if type(value) is not int or not low <= value <= high:
        _fail(path, "Expected an integer in the declared range")
    return value


def _constant(value: Any, expected: Any, path: str) -> None:
    if type(value) is not type(expected) or value != expected:
        _fail(path, "Contract constant differs")


def canonical_iso_milliseconds(value: Any, path: str = "") -> int:
    """JS Date.toISOString form, including year zero and signed extended years."""
    if not isinstance(value, str) or (match := _ISO.fullmatch(value)) is None:
        _fail(path, "Timestamp is not canonical UTC ISO")
    year, month, day, hour, minute, second, fraction = map(int, match.groups())
    spelling = f"{year:04d}" if 0 <= year <= 9999 else ("+" if year >= 0 else "-") + f"{abs(year):06d}"
    if match[1] != spelling:
        _fail(path, "Timestamp year spelling is not canonical")
    leap = year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)
    lengths = (31, 29 if leap else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31)
    if not 1 <= month <= 12 or not 1 <= day <= lengths[month - 1] or hour > 23 or minute > 59 or second > 59:
        _fail(path, "Timestamp calendar fields are invalid")
    adjusted = year - (month <= 2)
    era = adjusted // 400
    year_of_era = adjusted - era * 400
    day_of_year = (153 * (month + (-3 if month > 2 else 9)) + 2) // 5 + day - 1
    days = era * 146097 + year_of_era * 365 + year_of_era // 4 - year_of_era // 100 + day_of_year - 719468
    result = days * 86_400_000 + hour * 3_600_000 + minute * 60_000 + second * 1000 + fraction
    if abs(result) > 8_640_000_000_000_000:
        _fail(path, "Timestamp exceeds the pinned Date range")
    return result


def _recorded_timestamp(value: Any, path: str) -> None:
    if not isinstance(value, str) or re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,3})?Z", value, re.ASCII) is None:
        _fail(path, "Historical timestamp syntax differs")
    main, _, fraction = value[:-1].partition(".")
    canonical_iso_milliseconds(main + "." + fraction.ljust(3, "0") + "Z", path)


def _ipv4_number(part: str) -> int | None:
    if not part:
        return None
    base = 10
    digits = part
    if digits.lower().startswith("0x"):
        base, digits = 16, digits[2:]
    elif len(digits) >= 2 and digits.startswith("0"):
        base, digits = 8, digits[1:]
    if not digits:
        return 0
    alphabet = {8: r"[0-7]+", 10: r"[0-9]+", 16: r"[0-9a-fA-F]+"}[base]
    if re.fullmatch(alphabet, digits, re.ASCII) is None:
        return None
    # A URL is capped at 2048 UTF-16 units, so this remains bounded.
    return int(digits, base)


def _hostname(host: str, bracketed: bool) -> tuple[str, int]:
    """The URL-standard host normalization needed by the pinned safety rule."""
    host = unquote(host, encoding="utf-8", errors="strict").lower()
    if any(c in host for c in "\x00\t\n\r #%/:<>?@[\\]^|") and ":" not in host:
        raise ValueError("invalid URL host")
    if ":" in host:
        if not bracketed or "%" in host:
            raise ValueError("invalid URL IPv6 host")
        return ipaddress.IPv6Address(host).compressed, 6
    if bracketed:
        raise ValueError("invalid bracketed URL host")
    # Python's built-in IDNA2003 codec is not WHATWG's UTS46 processing.
    # Refuse to certify that optional corner rather than invent a local dialect.
    if not host.isascii() or any(label.startswith("xn--") for label in host.split(".")):
        raise SchemaViolation("unsupported_contract_feature", "", "Internationalized URL hosts require the pinned WHATWG/UTS46 contract")
    if any(ord(c) <= 32 or ord(c) == 127 or c in "#%/:<>?@[\\]^|" for c in host):
        raise ValueError("invalid URL host")
    parts = host.split(".")
    if parts[-1] == "":
        parts.pop()
    if not parts:
        raise ValueError("empty URL host")
    last = _ipv4_number(parts[-1])
    ends_in_number = last is not None or re.fullmatch(r"[0-9]+", parts[-1], re.ASCII) is not None
    if not ends_in_number:
        return host.removesuffix("."), 0
    numbers = [_ipv4_number(part) for part in parts]
    if len(numbers) > 4 or any(n is None for n in numbers) or any(n > 255 for n in numbers[:-1]) or numbers[-1] >= 256 ** (5 - len(numbers)):
        raise ValueError("invalid URL IPv4 address")
    address = numbers[-1]
    for i, number in enumerate(numbers[:-1]):
        address += number * 256 ** (3 - i)
    return str(ipaddress.IPv4Address(address)), 4


def _url_path(path: str) -> str:
    # URL-standard dot segments are removed before the pinned encoded-path test.
    segments = (path or "/").split("/")
    output: list[str] = []
    for i, segment in enumerate(segments):
        folded = segment.lower()
        if folded in (".", "%2e"):
            if i == len(segments) - 1:
                output.append("")
        elif folded in ("..", ".%2e", "%2e.", "%2e%2e"):
            if len(output) > 1:
                output.pop()
            if i == len(segments) - 1:
                output.append("")
        else:
            output.append(segment)
    return "/".join(output) or "/"


def safe_public_url(value: Any, path: str = "") -> bool:
    """Pure lexical policy; no DNS, HTTP, source lookup, or rights assertion."""
    if not _scalar(value) or len(value.encode("utf-16-le")) // 2 > 2048 or any(c in _WS or c == "\\" or ord(c) < 32 or ord(c) == 127 for c in value):
        return False
    match = re.match(r"(https?):/*(.*)\Z", value, re.ASCII | re.IGNORECASE)
    if match is None:
        return False
    try:
        url = urlsplit(match[1].lower() + "://" + match[2])
        if not url.hostname or (url.username or "") or (url.password or ""):
            return False
        url.port  # Validate its range, including malformed or excessive ports.
        host, version = _hostname(url.hostname, url.netloc.rsplit("@", 1)[-1].startswith("["))
        if host == "localhost" or host.endswith(".localhost"):
            return False
        for key, _ in parse_qsl(url.query, keep_blank_values=True):
            if _FORBIDDEN_QUERY.fullmatch(key) or key.lower().startswith("utm_"):
                return False
        encoded = _url_path(url.path)
        if re.search(r"%(?:25|2f|5c|2e)", encoded, re.ASCII | re.IGNORECASE):
            return False
        path = encoded
        for _ in range(3):
            # decodeURIComponent refuses malformed escapes, unlike unquote.
            if re.search(r"%(?![0-9a-fA-F]{2})", path):
                return False
            path = unquote(path, encoding="utf-8", errors="strict")
        if "%" in path or "\\" in path or _PRIVATE_PATH.match(path):
            return False
        if version == 4:
            a, b, c, _ = map(int, host.split("."))
            if a in (0, 10, 127) or a >= 224 or (a == 100 and 64 <= b <= 127) or (a == 169 and b == 254) or (a == 172 and 16 <= b <= 31) or (a == 192 and ((b == 0 and c in (0, 2)) or b == 168 or (b == 88 and c == 99))) or (a == 198 and (b in (18, 19) or (b == 51 and c == 100))) or (a == 203 and b == 0 and c == 113):
                return False
        if version == 6:
            if host in ("::", "::1") or host.startswith("::ffff:"):
                return False
            parts = [part for part in host.split(":") if part]
            first = int(parts[0], 16) if parts else 0
            second = int(parts[1], 16) if len(parts) > 1 else 0
            if first < 0x2000 or first >= 0x4000 or first in (0x3FFF, 0x2002) or (first == 0x2001 and (second <= 0x01FF or second in (0x0020, 0x0DB8))):
                return False
        return True
    except SchemaViolation as error:
        if not error.path:
            error.path = path
        raise
    except (ValueError, UnicodeError, OverflowError):
        return False


def safe_public_href(value: Any, path: str = "") -> bool:
    return isinstance(value, str) and (_CITATION_ROUTE.fullmatch(value) is not None or safe_public_url(value, path))


def canonical_source_href(value: Any, source_id: Any = None) -> bool:
    """Accept only the Source route-key owner's reversible, id-bound route."""
    if not isinstance(value, str) or _SOURCE_ROUTE.fullmatch(value) is None:
        return False
    route_key = value[len("/sources/"):]
    if route_key in _SOURCE_RESERVED:
        return False
    decoded: list[str] = []
    index = 0
    while index < len(route_key):
        char = route_key[index]
        if char != "~":
            decoded.append(char)
            index += 1
            continue
        if index + 1 >= len(route_key) or route_key[index + 1] not in ("c", "t"):
            return False
        decoded.append(":" if route_key[index + 1] == "c" else "~")
        index += 2
    decoded_id = "".join(decoded)
    if _SOURCE_ID.fullmatch(decoded_id) is None:
        return False
    expected = source_id if isinstance(source_id, str) else decoded_id
    if _SOURCE_ID.fullmatch(expected) is None:
        return False
    encoded = expected.replace("~", "~t").replace(":", "~c")
    return decoded_id == expected and route_key == encoded


def native_context_card_page(value: Any) -> bool:
    """Amended context metadata only; never a producer reference route."""
    if not isinstance(value, str) or len(value) > 1024:
        return False
    route, separator, fragment = value.partition("#")
    return bool(
        separator
        and re.fullmatch(r"/entries/[a-z0-9][a-z0-9-]{0,180}", route, re.ASCII | re.IGNORECASE)
        and re.fullmatch(r"source-card-[A-Za-z0-9_-]+", fragment, re.ASCII)
    )


def safe_context_page(value: Any, path: str = "") -> bool:
    return safe_public_href(value, path) or native_context_card_page(value)


def _canonical_context(value: Any) -> str:
    """Pinned public-selection size encoding: C0 uses six-character escapes."""
    if value is None:
        return "null"
    if type(value) is bool:
        return "true" if value else "false"
    if type(value) is int:
        return str(value)
    if isinstance(value, str):
        return '"' + "".join('\\"' if c == '"' else "\\\\" if c == "\\" else f"\\u{ord(c):04x}" if ord(c) <= 31 else c for c in value) + '"'
    if type(value) is list:
        return "[" + ",".join(_canonical_context(item) for item in value) + "]"
    return "{" + ",".join(json.dumps(key) + ":" + _canonical_context(value[key]) for key in sorted(value)) + "}"


def _snapshot(value: Any, path: str) -> None:
    value = _object(value, {"posture", "source_id", "source_href", "capture_ref", "historical_checks"}, path)
    _constant(value["posture"], "copied_public_context", path + "/posture")
    source = _text(value["source_id"], 256, path + "/source_id", 1, line=True, utf16=True)
    route_key = source.replace("~", "~t").replace(":", "~c")
    href = value["source_href"]
    if not canonical_source_href(href, source) or href != "/sources/" + route_key:
        _fail(path + "/source_href", "Copied Source route is not exact and canonical")
    capture = value["capture_ref"]
    if capture is not None:
        _match(capture, _HASH, path + "/capture_ref")
    checks = _array(value["historical_checks"], 8, path + "/historical_checks")
    digests: set[str] = set()
    normalized_checks: list[dict[str, Any]] = []
    for i, check in enumerate(checks):
        at = f"{path}/historical_checks/{i}"
        check = _object(check, {"posture", "check_id", "receipt_digest", "receipt_href", "checked_at", "capture_ref", "authority_ref", "results", "attestation_limits", "source_edition_binding"}, at)
        _constant(check["posture"], "historical", at + "/posture")
        _text(check["check_id"], 256, at + "/check_id", 1, line=True, utf16=True)
        digest = _match(check["receipt_digest"], _HASH, at + "/receipt_digest")
        if digest in digests:
            _fail(at + "/receipt_digest", "Duplicate historical receipt")
        digests.add(digest)
        _constant(check["receipt_href"], "/api/check/" + digest[7:], at + "/receipt_href")
        _recorded_timestamp(check["checked_at"], at + "/checked_at")
        _match(check["capture_ref"], _HASH, at + "/capture_ref")
        _constant(check["capture_ref"], capture, at + "/capture_ref")
        _text(check["authority_ref"], 2048, at + "/authority_ref", 1, line=True, utf16=True)
        special = source == "cp:source:01a093fa-4b2f-70cc-99c4-e1edbf49e43d" and check["check_id"] == "check-m1-ecf514-20260822" and capture == "sha256:1944d092241e9891baa8136be8463ce30bf3c7fd6a285697cb6f8c1dce592587"
        _constant(check["source_edition_binding"], "not_established" if special else "not_evaluated_by_receipt", at + "/source_edition_binding")
        dimensions: set[str] = set()
        for j, result in enumerate(_array(check["results"], 32, at + "/results", 1)):
            where = f"{at}/results/{j}"
            result = _object(result, {"dimension", "state", "reason_code"}, where)
            dimension = _text(result["dimension"], 128, where + "/dimension", 1, line=True, utf16=True)
            _match(dimension, re.compile(r"[a-z][a-z0-9_]*\Z", re.ASCII), where + "/dimension")
            if dimension in dimensions:
                _fail(where + "/dimension", "Duplicate Check result dimension")
            dimensions.add(dimension)
            if result["state"] not in ("established", "not_established", "not_evaluated"):
                _fail(where + "/state", "Unknown historical Check state")
            if result["state"] == "established":
                _constant(result["reason_code"], None, where + "/reason_code")
            else:
                _text(result["reason_code"], 1024, where + "/reason_code", 1, line=True, utf16=True)
        for j, limit in enumerate(_array(check["attestation_limits"], 32, at + "/attestation_limits")):
            _text(limit, 4096, f"{at}/attestation_limits/{j}", 1, line=True, utf16=True)
        # Field order is the pinned normalized snapshot representation used for its byte cap.
        normalized_checks.append({key: check[key] for key in ("posture", "check_id", "receipt_digest", "receipt_href", "checked_at", "capture_ref", "authority_ref", "results", "attestation_limits", "source_edition_binding")})
    normalized = {"posture": value["posture"], "source_id": source, "source_href": href, "capture_ref": capture, "historical_checks": normalized_checks}
    if len(json.dumps(normalized, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) > 65_536:
        _fail(path, "Copied public snapshot exceeds its byte limit")


def _item(value: Any, path: str) -> str:
    value = _object(value, {"source_occurrence", "claimed_metadata", "review"}, path)
    occurrence = _object(value["source_occurrence"], {"namespace", "id"}, path + "/source_occurrence")
    _constant(occurrence["namespace"], "counterpedia.public_reference", path + "/source_occurrence/namespace")
    identity = _match(occurrence["id"], _CONTEXT_ID, path + "/source_occurrence/id")
    metadata = _object(value["claimed_metadata"], {"title", "issuer", "dates", "page", "original_address", "origin"}, path + "/claimed_metadata", {"public_source_snapshot"})
    _text(metadata["title"], 500, path + "/claimed_metadata/title", 1, line=True)
    if metadata["issuer"] is not None:
        _text(metadata["issuer"], 300, path + "/claimed_metadata/issuer", 1, line=True)
    for i, date in enumerate(_array(metadata["dates"], 8, path + "/claimed_metadata/dates")):
        at = f"{path}/claimed_metadata/dates/{i}"
        date = _object(date, {"label", "value"}, at)
        _text(date["label"], 80, at + "/label", 1, line=True)
        _text(date["value"], 120, at + "/value", 1, line=True)
    page, address = metadata["page"], metadata["original_address"]
    if page is None and address is None:
        _fail(path + "/claimed_metadata", "A reference requires an address or page")
    if page is not None:
        _text(page, 1024, path + "/claimed_metadata/page", 1, utf16=True)
        if (
            not page.startswith("/")
            or page.startswith(("//", "/\\"))
            or not (
                safe_context_page(page, path + "/claimed_metadata/page")
                or ("~" in page and canonical_source_href(page))
            )
        ):
            _fail(path + "/claimed_metadata/page", "Unsafe public reference page")
    if address is not None:
        if any(ord(c) < 32 or 127 <= ord(c) <= 159 for c in _text(address, 2048, path + "/claimed_metadata/original_address", 1, utf16=True)) or not safe_public_url(address, path + "/claimed_metadata/original_address"):
            _fail(path + "/claimed_metadata/original_address", "Unsafe public reference address")
    if metadata["origin"] not in ("search_result", "entry_selection", "source_reader"):
        _fail(path + "/claimed_metadata/origin", "Unknown reference origin")
    if "public_source_snapshot" in metadata:
        _snapshot(metadata["public_source_snapshot"], path + "/claimed_metadata/public_source_snapshot")
        if metadata["origin"] not in ("source_reader", "search_result") or page != metadata["public_source_snapshot"]["source_href"]:
            _fail(path + "/claimed_metadata/public_source_snapshot", "Copied snapshot origin/page differs")
    review = _object(value["review"], {"decision", "note"}, path + "/review")
    if review["decision"] not in ("keep", "hold", "exclude", "unmarked"):
        _fail(path + "/review/decision", "Unknown review decision")
    _text(review["note"], 4000, path + "/review/note")
    return identity


def _selection(value: Any, path: str) -> dict[str, dict[str, Any]]:
    value = _object(value, {"schema", "source_format", "items", "relationships", "notes"}, path)
    _constant(value["schema"], "counterpedia.research_context.selection.v0.1", path + "/schema")
    _constant(value["source_format"], "counterpedia.public-reference-selection/v1", path + "/source_format")
    _constant(value["relationships"], [], path + "/relationships")
    notes = _object(value["notes"], {"working_answer", "still_to_check"}, path + "/notes")
    for key, note in notes.items():
        _text(note, 12_000, path + "/notes/" + key)
    items = _array(value["items"], 24, path + "/items", 1)
    by_id: dict[str, dict[str, Any]] = {}
    addresses: set[tuple[str, str | None, str | None]] = set()
    for i, item in enumerate(items):
        at = f"{path}/items/{i}"
        identity = _item(item, at)
        if identity in by_id:
            _fail(at, "Duplicate positional context ID")
        by_id[identity] = item
        metadata = item["claimed_metadata"]
        address = (metadata["title"], metadata["page"], metadata["original_address"])
        if address in addresses:
            _fail(at, "Duplicate reference title/page/address")
        addresses.add(address)
    if set(by_id) != {f"r{i:02d}" for i in range(1, len(items) + 1)}:
        _fail(path + "/items", "Context membership is not complete and positional")
    if len(_canonical_context(value).encode("utf-8")) > 256 * 1024:
        _fail(path, "Public-reference selection exceeds its byte limit")
    return by_id


def _reference(value: Any, observation_id: str, path: str) -> dict[str, Any] | None:
    if type(value) is not dict:
        _fail(path, "Expected a typed reference")
    kind = value.get("kind")
    if kind == "opaque_reference":
        value = _object(value, {"kind", "family", "reference_id", "status"}, path)
        family = _match(value["family"], re.compile(r"[a-z][a-z0-9_.:-]{0,127}\Z", re.ASCII), path + "/family")
        if family in _PUBLIC | _CONTROLLED:
            _fail(path + "/family", "Known family cannot use the opaque escape hatch")
        identity = _match(value["reference_id"], re.compile(r"[A-Za-z0-9._:~-]{1,256}\Z", re.ASCII), path + "/reference_id")
        _constant(value["status"], "unsupported", path + "/status")
        return {"path": path, "family": family, "reference_id": identity}
    value = _object(value, {"kind", "ref"}, path)
    _constant(kind, "public_reference", path + "/kind")
    ref = value["ref"]
    if type(ref) is not dict:
        _fail(path + "/ref", "Expected an exact public reference")
    family = ref.get("family")
    if family == _SECTION:
        _object(ref, {"family", "route", "section", "text_sha256", "binding_sha256"}, path + "/ref")
        route = _match(ref["route"], re.compile(r"/[A-Za-z0-9._~/-]{1,200}\Z", re.ASCII), path + "/ref/route")
        if ".." in route or not safe_public_href(route, path + "/ref/route"):
            _fail(path + "/ref/route", "Unsafe public section route")
        _match(ref["section"], re.compile(r"[A-Za-z0-9._:-]{1,160}\Z", re.ASCII), path + "/ref/section")
        _match(ref["text_sha256"], _HEX, path + "/ref/text_sha256")
        _match(ref["binding_sha256"], _HEX, path + "/ref/binding_sha256")
        identity = {key: ref[key] for key in ("family", "route", "section")}
    elif family == _SOURCE:
        _object(ref, {"family", "source_id", "capture_referent_id", "captured_bytes_sha256"}, path + "/ref")
        _match(ref["source_id"], re.compile(r"[A-Za-z0-9._:~-]{1,160}\Z", re.ASCII), path + "/ref/source_id")
        _match(ref["capture_referent_id"], re.compile(r"[A-Za-z0-9._:~-]{1,300}\Z", re.ASCII), path + "/ref/capture_referent_id")
        _match(ref["captured_bytes_sha256"], _HASH, path + "/ref/captured_bytes_sha256")
        identity = {key: ref[key] for key in ("family", "source_id")}
    elif family == _RECORD:
        _object(ref, {"family", "evidence_id", "record_id", "edition_id", "anchor", "text_sha256"}, path + "/ref")
        for key in ("record_id", "edition_id"):
            _match(ref[key], _RECORD_PART, path + "/ref/" + key)
        _match(ref["text_sha256"], _HEX, path + "/ref/text_sha256")
        anchor = ref["anchor"]
        if type(anchor) is not dict:
            _fail(path + "/ref/anchor", "Expected a typed record anchor")
        if anchor.get("kind") == "span":
            _object(anchor, {"kind", "span_id"}, path + "/ref/anchor")
            _match(anchor["span_id"], _RECORD_PART, path + "/ref/anchor/span_id")
            suffix = "span:" + anchor["span_id"]
        elif anchor.get("kind") == "paragraph":
            _object(anchor, {"kind", "section_id", "paragraph_index"}, path + "/ref/anchor")
            _match(anchor["section_id"], _RECORD_PART, path + "/ref/anchor/section_id")
            _integer(anchor["paragraph_index"], 0, 10_000, path + "/ref/anchor/paragraph_index")
            suffix = "para:" + anchor["section_id"] + ":" + str(anchor["paragraph_index"])
        else:
            _fail(path + "/ref/anchor/kind", "Unknown record anchor kind")
        _constant(ref["evidence_id"], f"record:{ref['record_id']}@{ref['edition_id']}#{suffix}", path + "/ref/evidence_id")
        identity = {key: ref[key] for key in ("family", "record_id", "anchor")}
    else:
        _fail(path + "/ref/family", "Unknown or controlled family cannot be supported")
    # Identity values are ASCII-only, with integer paragraph indices: stdlib JSON
    # with sorted keys reproduces the declared identity preimage independently.
    preimage = json.dumps(identity, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    _constant(observation_id, "ob_" + hashlib.sha256(preimage).hexdigest()[:24], path + "/observation_id")
    return None


def _source_id_from_reference(value: Any) -> str | None:
    if not isinstance(value, dict) or value.get("kind") != "public_reference":
        return None
    ref = value.get("ref")
    if not isinstance(ref, dict) or ref.get("family") != _SOURCE:
        return None
    source_id = ref.get("source_id")
    return source_id if isinstance(source_id, str) else None


def validate_research_workspace(document: dict[str, Any]) -> list[dict[str, Any]]:
    """Validate this frozen serialized contract and report uninterpreted refs.

    The caller must separately recompute every portable digest. Successful
    validation is never a current-source, authenticity, truth or rights verdict.
    """
    doc = _object(document, {"schema", "profile", "canonicalization", "authenticity", "complete", "selected_revision", "revisions", "export"}, "")
    for name, expected in (("schema", _PACK), ("profile", "researcher_private_portable"), ("canonicalization", "cp-rwp-json-v1"), ("authenticity", "not_established"), ("complete", True)):
        _constant(doc[name], expected, "/" + name)
    count = _integer(doc["selected_revision"], 1, 50, "/selected_revision")
    revisions = _array(doc["revisions"], 50, "/revisions", 1)
    if len(revisions) != count:
        _fail("/revisions", "Selected revision and complete chain length differ")
    unsupported: list[dict[str, Any]] = []
    expected_readback: list[tuple[int, str, bool]] = []
    parent: str | None = None
    original_selection: dict[str, Any] | None = None
    for index, revision in enumerate(revisions):
        path = f"/revisions/{index}"
        revision = _object(revision, {"schema", "revision", "parent_portable_revision_sha256", "saved_at", "question", "propositions", "observations", "assessments", "finding", "context_selection", "research_context", "withholding", "portable_revision_sha256"}, path)
        _constant(revision["schema"], _REVISION, path + "/schema")
        _integer(revision["revision"], 1, 50, path + "/revision")
        _constant(revision["revision"], index + 1, path + "/revision")
        _constant(revision["parent_portable_revision_sha256"], parent, path + "/parent_portable_revision_sha256")
        parent = _match(revision["portable_revision_sha256"], _HASH, path + "/portable_revision_sha256")
        canonical_iso_milliseconds(revision["saved_at"], path + "/saved_at")
        _text(revision["question"], 500, path + "/question", 5)
        _constant(revision["withholding"], [], path + "/withholding")
        propositions: set[str] = set()
        for i, proposition in enumerate(_array(revision["propositions"], 12, path + "/propositions")):
            at = f"{path}/propositions/{i}"
            proposition = _object(proposition, {"proposition_id", "text"}, at)
            identity = _match(proposition["proposition_id"], _PROPOSITION, at + "/proposition_id")
            if identity in propositions:
                _fail(at + "/proposition_id", "Duplicate proposition ID")
            propositions.add(identity)
            _text(proposition["text"], 500, at + "/text", 1)
        observations: set[str] = set()
        for i, observation in enumerate(_array(revision["observations"], 24, path + "/observations")):
            at = f"{path}/observations/{i}"
            observation = _object(observation, {"observation_id", "reference", "source_kind", "metadata_at_save", "provenance_at_save"}, at)
            identity = _match(observation["observation_id"], _OBSERVATION, at + "/observation_id")
            if identity in observations:
                _fail(at + "/observation_id", "Duplicate observation ID")
            observations.add(identity)
            # No narrower source_kind vocabulary is specified by the portable
            # contract; total input limits bound this asserted display value.
            _text(observation["source_kind"], 4_194_304, at + "/source_kind", 1)
            reference = observation["reference"]
            opaque = _reference(reference, identity, at + "/reference")
            if opaque is not None:
                unsupported.append(opaque)
                _constant(observation["source_kind"], "unsupported", at + "/source_kind")
            metadata = _object(observation["metadata_at_save"], {"title", "label", "href", "posture", "provenance_note"}, at + "/metadata_at_save")
            _text(metadata["title"], 2000, at + "/metadata_at_save/title", 1)
            for key, maximum in (("label", 2000), ("posture", 2000), ("provenance_note", 4000)):
                _nullable(metadata[key], maximum, at + "/metadata_at_save/" + key)
            source_id = _source_id_from_reference(reference)
            if metadata["href"] != "" and not (
                safe_public_href(metadata["href"], at + "/metadata_at_save/href")
                or (source_id is not None and canonical_source_href(metadata["href"], source_id))
            ):
                _fail(at + "/metadata_at_save/href", "Unsafe public evidence href")
            provenance = _object(observation["provenance_at_save"], {"public_research_release_id", "section_provenance_sha256"}, at + "/provenance_at_save")
            _nullable(provenance["public_research_release_id"], 256, at + "/provenance_at_save/public_research_release_id")
            if provenance["section_provenance_sha256"] is not None:
                _match(provenance["section_provenance_sha256"], _HASH, at + "/provenance_at_save/section_provenance_sha256")
            expected_readback.append((index + 1, identity, opaque is not None))
        if observations and not propositions:
            _fail(path + "/propositions", "Evidence-bearing revision requires propositions")
        assessments = _array(revision["assessments"], 288, path + "/assessments")
        pairs: set[tuple[str, str]] = set()
        for i, assessment in enumerate(assessments):
            at = f"{path}/assessments/{i}"
            assessment = _object(assessment, {"observation_id", "proposition_id", "stance", "note", "author", "authorship_basis"}, at)
            pair = (assessment["observation_id"], assessment["proposition_id"])
            if not all(isinstance(part, str) for part in pair) or pair[0] not in observations or pair[1] not in propositions or pair in pairs:
                _fail(at, "Assessment anchor is missing, foreign or duplicated")
            pairs.add(pair)
            if assessment["stance"] not in ("supports", "conflicts", "not_assessed"):
                _fail(at + "/stance", "Unknown assessment stance")
            _text(assessment["note"], 1000, at + "/note")
            _constant(assessment["author"], "user", at + "/author")
            _constant(assessment["authorship_basis"], "declared_by_saving_client", at + "/authorship_basis")
        if len(pairs) != len(observations) * len(propositions):
            _fail(path + "/assessments", "Every observation/proposition pair must appear once")
        finding = _object(revision["finding"], {"text", "author"}, path + "/finding")
        _constant(finding["author"], "user", path + "/finding/author")
        _text(finding["text"], 8000, path + "/finding/text")
        selected = _selection(revision["context_selection"], path + "/context_selection")
        if original_selection is None:
            original_selection = revision["context_selection"]
        elif revision["context_selection"] != original_selection:
            _fail(path + "/context_selection", "Original context selection changed across revisions")
        rows = _array(revision["research_context"], 24, path + "/research_context", 1)
        seen_context: set[str] = set()
        for i, row in enumerate(rows):
            at = f"{path}/research_context/{i}"
            row = _object(row, {"context_id", "source_occurrence", "claimed_metadata", "review", "related_context_ids", "observation_ids"}, at)
            identity = _item({key: row[key] for key in ("source_occurrence", "claimed_metadata", "review")}, at)
            if identity not in selected or identity in seen_context or row["context_id"] != identity:
                _fail(at + "/context_id", "Context row membership differs")
            seen_context.add(identity)
            before = selected[identity]["claimed_metadata"].get("public_source_snapshot")
            after = row["claimed_metadata"].get("public_source_snapshot")
            if before != after:
                _fail(at + "/claimed_metadata/public_source_snapshot", "Copied historical snapshot changed")
            for name, maximum, targets, forbid in (("related_context_ids", 24, set(selected), identity), ("observation_ids", 24, observations, None)):
                linked = _array(row[name], maximum, at + "/" + name)
                if not all(isinstance(v, str) for v in linked) or len(set(linked)) != len(linked) or any(v not in targets or v == forbid for v in linked):
                    _fail(at + "/" + name, "Context cross-reference is unknown or duplicated")
        if seen_context != set(selected):
            _fail(path + "/research_context", "Historical context membership is incomplete")
    envelope = _object(doc["export"], {"exported_at", "head_portable_revision_sha256", "readback", "limitations", "export_sha256"}, "/export")
    exported = canonical_iso_milliseconds(envelope["exported_at"], "/export/exported_at")
    _constant(envelope["head_portable_revision_sha256"], parent, "/export/head_portable_revision_sha256")
    _match(envelope["export_sha256"], _HASH, "/export/export_sha256")
    _constant(envelope["limitations"], _LIMITS, "/export/limitations")
    readback = _array(envelope["readback"], 1200, "/export/readback")
    if len(readback) != len(expected_readback):
        _fail("/export/readback", "Readback cardinality differs from carried observations")
    for i, (entry, expected) in enumerate(zip(readback, expected_readback)):
        at = f"/export/readback/{i}"
        entry = _object(entry, {"revision", "observation_id", "observed_at", "state", "basis"}, at)
        revision, identity, opaque = expected
        _integer(entry["revision"], 1, 50, at + "/revision")
        _constant(entry["revision"], revision, at + "/revision")
        _constant(entry["observation_id"], identity, at + "/observation_id")
        if canonical_iso_milliseconds(entry["observed_at"], at + "/observed_at") > exported:
            _fail(at + "/observed_at", "Readback is later than export")
        states = ("unsupported",) if opaque else ("current", "stale", "unavailable", "unreadable")
        if entry["state"] not in states:
            _fail(at + "/state", "Readback status does not match reference kind")
        _constant(entry["basis"], _BASES[entry["state"]], at + "/basis")
    return unsupported
