"""Persistent local CUDA worker for Cohere Transcribe.

The parent process sends one JSON header line followed by raw little-endian
PCM16 bytes. The worker writes one bounded JSON response line to stdout.
Everything else, including library diagnostics, stays off stdout so the wire
protocol cannot be confused with logs.
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", newline="\n")

MODEL_ID = "cohere-transcribe-03-2026"
MODEL_FILE = "model.safetensors"
SAMPLE_RATE_HZ = 16_000
MAX_SAMPLE_COUNT = SAMPLE_RATE_HZ * 120
MAX_HEADER_BYTES = 8_192
SUPPORTED_LANGUAGES = frozenset(("en", "ja", "zh"))


def emit(payload: dict[str, object]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def fail(code: str, request_id: int | None = None) -> None:
    payload: dict[str, object] = {"type": "error", "code": code}
    if request_id is not None:
        payload["id"] = request_id
    emit(payload)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while block := source.read(8 * 1024 * 1024):
            digest.update(block)
    return digest.hexdigest()


def read_exact(stream, length: int) -> bytes:
    payload = bytearray(length)
    view = memoryview(payload)
    offset = 0
    while offset < length:
        received = stream.readinto(view[offset:])
        if not received:
            raise EOFError
        offset += received
    return bytes(payload)


def load_runtime():
    model_dir_value = os.environ.get("MEETINGRELAY_COHERE_MODEL_DIR", "").strip()
    expected_sha256 = os.environ.get("MEETINGRELAY_COHERE_MODEL_SHA256", "").strip().lower()
    if not model_dir_value or len(expected_sha256) != 64:
        raise RuntimeError("COHERE_ASR_CONFIG_INVALID")

    model_dir = Path(model_dir_value)
    model_file = model_dir / MODEL_FILE
    if not model_file.is_file():
        raise RuntimeError("COHERE_ASR_MODEL_MISSING")
    if sha256_file(model_file) != expected_sha256:
        raise RuntimeError("COHERE_ASR_MODEL_INVALID")

    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
    os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
    os.environ.setdefault("TRANSFORMERS_VERBOSITY", "error")

    import numpy as np
    import torch
    from transformers import AutoProcessor, CohereAsrForConditionalGeneration

    if not torch.cuda.is_available():
        raise RuntimeError("COHERE_ASR_CUDA_UNAVAILABLE")

    processor = AutoProcessor.from_pretrained(model_dir, local_files_only=True)
    model = CohereAsrForConditionalGeneration.from_pretrained(
        model_dir,
        dtype=torch.bfloat16,
        local_files_only=True,
    ).to("cuda")
    model.eval()
    torch.cuda.synchronize()
    return np, torch, processor, model


def transcribe(np, torch, processor, model, raw_audio: bytes, language: str) -> str:
    audio = np.frombuffer(raw_audio, dtype="<i2").astype(np.float32) / 32768.0
    inputs = processor(
        audio,
        sampling_rate=SAMPLE_RATE_HZ,
        return_tensors="pt",
        language=language,
    )
    inputs.to(model.device, dtype=model.dtype)
    audio_seconds = max(1, (len(audio) + SAMPLE_RATE_HZ - 1) // SAMPLE_RATE_HZ)
    max_new_tokens = min(256, max(48, audio_seconds * 16))
    with torch.inference_mode():
        outputs = model.generate(**inputs, max_new_tokens=max_new_tokens)
    decoded = processor.decode(outputs, skip_special_tokens=True)
    if isinstance(decoded, list):
        decoded = decoded[0]
    return str(decoded).strip()


def run() -> int:
    try:
        np, torch, processor, model = load_runtime()
    except RuntimeError as error:
        fail(str(error))
        return 2
    except Exception:
        fail("COHERE_ASR_PREPARE_FAILED")
        return 2

    emit(
        {
            "type": "ready",
            "modelId": MODEL_ID,
            "gpu": torch.cuda.get_device_name(0),
            "dtype": str(model.dtype),
        }
    )

    stream = sys.stdin.buffer
    while True:
        header_bytes = stream.readline(MAX_HEADER_BYTES + 1)
        if not header_bytes:
            return 0
        if len(header_bytes) > MAX_HEADER_BYTES or not header_bytes.endswith(b"\n"):
            fail("COHERE_ASR_PROTOCOL_INVALID")
            return 3
        try:
            request = json.loads(header_bytes)
            if request.get("type") == "shutdown":
                emit({"type": "stopped"})
                return 0
            request_id = request["id"]
            language = request["language"]
            sample_rate_hz = request["sampleRateHz"]
            sample_count = request["sampleCount"]
            if (
                not isinstance(request_id, int)
                or request_id < 0
                or language not in SUPPORTED_LANGUAGES
                or sample_rate_hz != SAMPLE_RATE_HZ
                or not isinstance(sample_count, int)
                or sample_count <= 0
                or sample_count > MAX_SAMPLE_COUNT
            ):
                raise ValueError
        except (KeyError, TypeError, ValueError, json.JSONDecodeError):
            fail("COHERE_ASR_REQUEST_INVALID")
            return 3

        try:
            raw_audio = read_exact(stream, sample_count * 2)
            text = transcribe(np, torch, processor, model, raw_audio, language)
            emit({"type": "result", "id": request_id, "text": text})
        except EOFError:
            fail("COHERE_ASR_AUDIO_TRUNCATED", request_id)
            return 3
        except torch.cuda.OutOfMemoryError:
            torch.cuda.empty_cache()
            fail("COHERE_ASR_CUDA_OUT_OF_MEMORY", request_id)
        except Exception:
            fail("COHERE_ASR_INFERENCE_FAILED", request_id)


if __name__ == "__main__":
    raise SystemExit(run())
