import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  OVERLAY_DEFAULT_FONT_SIZE_PX,
  OVERLAY_MAX_FONT_SIZE_PX,
  OVERLAY_MIN_FONT_SIZE_PX,
  nextOverlayFontSize,
  parseOverlayFontSize,
  selectOverlayCaptions,
} from "./caption-overlay-state.ts";
import { translationOnlyText } from "./frontend-state.ts";

function segment(overrides = {}) {
  const sequence = String(overrides.sequence ?? "1");
  return {
    segmentId: overrides.segmentId ?? `segment-${sequence}`,
    sequence,
    revision: 1,
    isFinal: true,
    saved: true,
    timelineRevision: 1,
    text: "confirmed source",
    startedAtMs: "0",
    endedAtMs: "100",
    committedAt: "100",
    commitId: `commit-${sequence}`,
    translationStatus: "disabled",
    translationTarget: null,
    translationText: null,
    translationError: null,
    meetingSampleStart: "0",
    meetingSampleEnd: "100",
    ...overrides,
    sequence,
  };
}

function interim(text) {
  return segment({
    segmentId: "segment-live",
    sequence: "0",
    isFinal: false,
    saved: false,
    endedAtMs: null,
    committedAt: null,
    commitId: null,
    text,
  });
}

test("overlay source display returns oldest-to-newest finals plus current interim", () => {
  assert.deepEqual(
    selectOverlayCaptions(
      {
        interim: interim(" live words "),
        finals: [
          segment({ sequence: "1", text: "oldest" }),
          segment({ sequence: "2", text: " older " }),
          segment({ sequence: "3", text: "newest final" }),
        ],
      },
      "source_and_translation",
    ),
    [
      { text: "older", kind: "final", key: "final:segment-2", current: false },
      { text: "newest final", kind: "final", key: "final:segment-3", current: false },
      { text: "live words", kind: "interim", key: "interim:segment-live", current: true },
    ],
  );
});

test("overlay source display returns the last three meaningful finals", () => {
  assert.deepEqual(
    selectOverlayCaptions(
      {
        interim: null,
        finals: [
          segment({ sequence: "1", text: "first" }),
          segment({ sequence: "2", text: " " }),
          segment({ sequence: "3", text: "second" }),
          segment({ sequence: "4", text: "third" }),
          segment({ sequence: "5", text: " fourth " }),
        ],
      },
      "source_and_translation",
    ),
    [
      { text: "second", kind: "final", key: "final:segment-3", current: false },
      { text: "third", kind: "final", key: "final:segment-4", current: false },
      { text: "fourth", kind: "final", key: "final:segment-5", current: true },
    ],
  );
});

test("overlay source display stays empty without interim or finals", () => {
  assert.deepEqual(
    selectOverlayCaptions({ interim: null, finals: [] }, "source_and_translation"),
    [{ text: "", kind: "empty", key: "empty", current: true }],
  );
});

test("overlay translation-only display maps latest finals through frontend-state without interim source", () => {
  const completedFinal = segment({
    sequence: "2",
    text: "final source must stay hidden",
    translationStatus: "completed",
    translationText: "翻訳だけ",
  });
  const pendingFinal = segment({
    sequence: "3",
    text: "pending source must stay hidden",
    translationStatus: "pending",
    translationText: null,
  });
  const failedFinal = segment({
    sequence: "4",
    text: "failed source must stay hidden",
    translationStatus: "failed",
    translationText: null,
  });

  assert.deepEqual(
    selectOverlayCaptions(
      {
        interim: interim("interim source must stay hidden"),
        finals: [
          segment({ sequence: "1", text: "ignored source", translationText: "ignored" }),
          completedFinal,
          pendingFinal,
          failedFinal,
        ],
      },
      "translation_only",
    ),
    [
      { ...translationOnlyText(completedFinal), key: "final:segment-2", current: false },
      { ...translationOnlyText(pendingFinal), key: "final:segment-3", current: false },
      { ...translationOnlyText(failedFinal), key: "final:segment-4", current: true },
    ],
  );
});

test("overlay translation-only status lines never fall back to skipped or disabled source text", () => {
  const skippedFinal = segment({
    sequence: "1",
    text: "skipped source must stay hidden",
    translationStatus: "skipped",
  });
  const disabledFinal = segment({
    sequence: "2",
    text: "disabled source must stay hidden",
    translationStatus: "disabled",
  });

  const captions = selectOverlayCaptions(
    {
      interim: interim("interim source must stay hidden"),
      finals: [skippedFinal, disabledFinal],
    },
    "translation_only",
  );

  assert.deepEqual(captions, [
    { ...translationOnlyText(skippedFinal), key: "final:segment-1", current: false },
    { ...translationOnlyText(disabledFinal), key: "final:segment-2", current: true },
  ]);
  assert.ok(captions.every((caption) => !caption.text.includes("source must stay hidden")));
});

test("overlay font size parsing is persisted as a bounded pixel value", () => {
  assert.equal(parseOverlayFontSize(null), OVERLAY_DEFAULT_FONT_SIZE_PX);
  assert.equal(parseOverlayFontSize("48px"), 48);
  assert.equal(parseOverlayFontSize("not a number"), OVERLAY_DEFAULT_FONT_SIZE_PX);
  assert.equal(parseOverlayFontSize("1"), OVERLAY_MIN_FONT_SIZE_PX);
  assert.equal(parseOverlayFontSize("999"), OVERLAY_MAX_FONT_SIZE_PX);
});

test("overlay font size controls step within bounds", () => {
  assert.equal(nextOverlayFontSize(34, "larger"), 38);
  assert.equal(nextOverlayFontSize(34, "smaller"), 30);
  assert.equal(nextOverlayFontSize(OVERLAY_MAX_FONT_SIZE_PX, "larger"), OVERLAY_MAX_FONT_SIZE_PX);
  assert.equal(nextOverlayFontSize(OVERLAY_MIN_FONT_SIZE_PX, "smaller"), OVERLAY_MIN_FONT_SIZE_PX);
});

test("overlay exposes only live captions plus bounded native window controls", () => {
  const overlaySource = readFileSync(new URL("./caption-overlay.ts", import.meta.url), "utf8");
  const tauriConfig = JSON.parse(
    readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"),
  );
  const capability = JSON.parse(
    readFileSync(
      new URL("../src-tauri/capabilities/caption-overlay.json", import.meta.url),
      "utf8",
    ),
  );

  assert.match(overlaySource, />实时字幕<\/span>/);
  assert.match(overlaySource, /aria-label="关闭悬浮字幕"/);
  assert.match(overlaySource, /<ul id="overlay-caption-list"/);
  assert.match(overlaySource, /renderedCaptionSignature/);
  assert.match(overlaySource, /if \(nextCaptionSignature !== renderedCaptionSignature\)/);
  assert.match(overlaySource, /overlayWindow\.startDragging\(\)/);
  assert.match(overlaySource, /overlayWindow\.startResizeDragging\("SouthEast"\)/);
  assert.match(overlaySource, /overlayWindow\.hide\(\)/);
  assert.match(overlaySource, /emitTo\(MAIN_WINDOW_LABEL, OVERLAY_HIDDEN_EVENT/);
  assert.doesNotMatch(overlaySource, /overlayWindow\.close\(\)|State|Time|Finals|revision|timeline|samples|等待实时字幕/);
  assert.ok(capability.permissions.includes("core:window:allow-start-dragging"));
  assert.ok(capability.permissions.includes("core:window:allow-start-resize-dragging"));
  assert.ok(capability.permissions.includes("core:window:allow-hide"));
  assert.ok(capability.permissions.includes("core:event:allow-emit-to"));
  const overlayWindow = tauriConfig.app.windows.find((window) => window.label === "caption-overlay");
  assert.equal(overlayWindow?.minWidth, 320);
  assert.equal(overlayWindow?.minHeight, 120);
  assert.equal(overlayWindow?.height, 280);
});
