"""Repeatable three-language smoke test for the Cohere worker protocol."""

from __future__ import annotations

import argparse
import json
import os
import queue
import subprocess
import sys
import threading
import time
import unicodedata
import wave
from pathlib import Path

MODEL_SHA256 = "987bd3e141c7bfdb5a78f5db11397ee7737308357e6cc0a3f36a4979b158137a"
CASES = (
    (
        "zh",
        "zh.wav",
        "今天下午三点，我们确认本地语音识别模型运行正常。",
    ),
    (
        "ja",
        "ja.wav",
        "本日の会議では、音声認識モデルの動作を確認します。",
    ),
    (
        "en",
        "en.wav",
        "Today we verify that the local speech recognition model is working correctly.",
    ),
)


def normalized_text(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value).casefold()
    return "".join(character for character in normalized if character.isalnum())


def edit_distance(left: str, right: str) -> int:
    previous = list(range(len(right) + 1))
    for left_index, left_character in enumerate(left, start=1):
        current = [left_index]
        for right_index, right_character in enumerate(right, start=1):
            current.append(
                min(
                    current[-1] + 1,
                    previous[right_index] + 1,
                    previous[right_index - 1]
                    + (left_character != right_character),
                )
            )
        previous = current
    return previous[-1]


def read_pcm16(path: Path) -> tuple[bytes, float]:
    with wave.open(str(path), "rb") as source:
        if (
            source.getnchannels() != 1
            or source.getsampwidth() != 2
            or source.getframerate() != 16_000
        ):
            raise ValueError(f"{path.name} must be mono 16 kHz PCM16")
        frame_count = source.getnframes()
        return source.readframes(frame_count), frame_count / 16_000


def response_reader(stream, responses: queue.Queue[bytes | None]) -> None:
    while line := stream.readline():
        responses.put(line)
    responses.put(None)


def receive(responses: queue.Queue[bytes | None], timeout_seconds: float) -> dict:
    try:
        line = responses.get(timeout=timeout_seconds)
    except queue.Empty as error:
        raise TimeoutError("worker response timed out") from error
    if line is None:
        raise RuntimeError("worker stopped before responding")
    value = json.loads(line.decode("utf-8"))
    if not isinstance(value, dict):
        raise RuntimeError("worker returned a non-object response")
    return value


def run(args: argparse.Namespace) -> tuple[int, dict]:
    environment = os.environ.copy()
    environment.update(
        {
            "PYTHONUTF8": "1",
            "PYTHONIOENCODING": "utf-8",
            "HF_HUB_OFFLINE": "1",
            "TRANSFORMERS_OFFLINE": "1",
            "HF_HUB_DISABLE_PROGRESS_BARS": "1",
            "TRANSFORMERS_VERBOSITY": "error",
            "MEETINGRELAY_COHERE_MODEL_DIR": str(args.model_dir),
            "MEETINGRELAY_COHERE_MODEL_SHA256": MODEL_SHA256,
        }
    )
    process = subprocess.Popen(
        [sys.executable, "-I", "-u", str(args.worker)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        env=environment,
    )
    if process.stdin is None or process.stdout is None:
        process.kill()
        raise RuntimeError("worker pipes were not created")

    responses: queue.Queue[bytes | None] = queue.Queue(maxsize=8)
    reader = threading.Thread(
        target=response_reader,
        args=(process.stdout, responses),
        daemon=True,
    )
    reader.start()

    try:
        ready_started = time.perf_counter()
        ready = receive(responses, args.prepare_timeout)
        load_seconds = time.perf_counter() - ready_started
        if ready.get("type") != "ready":
            raise RuntimeError(f"worker prepare failed: {ready.get('code', 'unknown')}")

        results = []
        for request_id, (language, file_name, expected) in enumerate(CASES, start=1):
            pcm, duration_seconds = read_pcm16(args.audio_dir / file_name)
            header = json.dumps(
                {
                    "type": "transcribe",
                    "id": request_id,
                    "language": language,
                    "sampleRateHz": 16_000,
                    "sampleCount": len(pcm) // 2,
                },
                separators=(",", ":"),
            ).encode("utf-8")
            started = time.perf_counter()
            process.stdin.write(header + b"\n")
            process.stdin.write(pcm)
            process.stdin.flush()
            response = receive(responses, args.inference_timeout)
            elapsed_seconds = time.perf_counter() - started
            if response.get("type") != "result" or response.get("id") != request_id:
                raise RuntimeError(
                    f"{language} inference failed: {response.get('code', 'invalid response')}"
                )
            actual = str(response.get("text", "")).strip()
            normalized_expected = normalized_text(expected)
            normalized_actual = normalized_text(actual)
            cer = edit_distance(normalized_expected, normalized_actual) / max(
                1, len(normalized_expected)
            )
            results.append(
                {
                    "language": language,
                    "expected": expected,
                    "actual": actual,
                    "durationSeconds": round(duration_seconds, 3),
                    "elapsedSeconds": round(elapsed_seconds, 3),
                    "rtf": round(elapsed_seconds / duration_seconds, 4),
                    "normalizedCer": round(cer, 4),
                    "passed": cer <= args.max_cer,
                }
            )

        report = {
            "schemaVersion": "meetingrelay.cohere-smoke.v1",
            "modelId": ready.get("modelId"),
            "gpu": ready.get("gpu"),
            "dtype": ready.get("dtype"),
            "loadSeconds": round(load_seconds, 3),
            "maxCer": args.max_cer,
            "results": results,
            "passed": all(result["passed"] for result in results),
        }
        return (0 if report["passed"] else 1), report
    finally:
        try:
            process.stdin.write(b'{"type":"shutdown"}\n')
            process.stdin.flush()
        except (BrokenPipeError, OSError):
            pass
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", type=Path, required=True)
    parser.add_argument("--audio-dir", type=Path, required=True)
    parser.add_argument(
        "--worker",
        type=Path,
        default=Path(__file__).with_name("worker.py"),
    )
    parser.add_argument("--output", type=Path)
    parser.add_argument("--max-cer", type=float, default=0.10)
    parser.add_argument("--prepare-timeout", type=float, default=120)
    parser.add_argument("--inference-timeout", type=float, default=60)
    args = parser.parse_args()

    status, report = run(args)
    rendered = json.dumps(report, ensure_ascii=False, indent=2)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered + "\n", encoding="utf-8")
    print(rendered)
    return status


if __name__ == "__main__":
    raise SystemExit(main())
