"""Verify one file from stdin. Return only the fields used by the Mike reader."""
import json
import sys

from arcs_verify.research_workspace import MAX_BYTES, verify_research_workspace_bytes

data = sys.stdin.buffer.read(MAX_BYTES + 1)
report = verify_research_workspace_bytes(data)
fields = ("schema", "input_sha256", "integrity", "authenticity", "failures")
print(json.dumps({key: report[key] for key in fields}, ensure_ascii=True))
