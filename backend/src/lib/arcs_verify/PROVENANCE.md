# ARCS verifier provenance

This offline verifier is pinned to the Counterpedia ARCS source at commit
`8cd47bfd689861135c806f5cbd5dc56644a4898a`. The implementation is kept under
`backend/src/lib/arcs_verify`; `bridge.py` is the only process entry point.

The bundled `LICENSE` file is the complete license text shipped with that
source snapshot. This integration does not fetch, update, or execute provider
code. The TypeScript service supplies bytes on stdin and accepts only the
typed JSON report emitted by the pinned bridge.
