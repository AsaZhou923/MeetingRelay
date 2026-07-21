"""MeetingRelay FunASR sidecar reference source placeholder.

This fixed file is intentionally parse/compile attested only in WP-0.4.4d.
It is not imported, executed, packaged, distributed, or quality assessed.
"""

from __future__ import annotations


SIDECAR_PROTOCOL = "meetingrelay-funasr-sidecar"


def describe_sidecar_contract() -> dict[str, str]:
    return {
        "protocol": SIDECAR_PROTOCOL,
        "execution": "not-executed",
        "authority": "source-attestation-only",
    }
