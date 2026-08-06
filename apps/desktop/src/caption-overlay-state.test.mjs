import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  OVERLAY_DEFAULT_FONT_SIZE_PX,
  OVERLAY_MAX_FONT_SIZE_PX,
  OVERLAY_MIN_FONT_SIZE_PX,
  nextOverlayFontSize,
  parseOverlayFontSize,
  selectOverlayCaption,
} from "./caption-overlay-state.ts";
import { translationOnlyText } from "./frontend-state.ts";

function segment(overrides = {}) {
  return {
    sequence: 1,
    revision: 1,
    timelineRevision: 1,
    text: "confirmed source",
    speakerId: null,
    speakerLabel: null,
    translationStatus: "disabled",
    translationText: null,
    meetingSampleStart: 0,
    meetingSampleEnd: 100,
    ...overrides,
  };
}

test("overlay source display prefers interim then keeps the newest final", () => {
  assert.deepEqual(
    selectOverlayCaption(
      {
        interim: segment({ text: " live words " }),
        finals: [segment({ text: "older" }), segment({ text: "newest final" })],
      },
      "source_and_translation",
    ),
    { text: "live words", kind: "interim" },
  );

  assert.deepEqual(
    selectOverlayCaption(
      {
        interim: null,
        finals: [segment({ text: "older" }), segment({ text: " newest final " })],
      },
      "source_and_translation",
    ),
    { text: "newest final", kind: "final" },
  );
});

test("overlay source display stays empty without interim or finals", () => {
  assert.deepEqual(
    selectOverlayCaption({ interim: null, finals: [] }, "source_and_translation"),
    { text: "", kind: "empty" },
  );
});

test("overlay translation-only display matches frontend-state and never shows interim source", () => {
  const completedFinal = segment({
    text: "final source must stay hidden",
    translationStatus: "completed",
    translationText: "翻訳だけ",
  });

  assert.deepEqual(
    selectOverlayCaption(
      {
        interim: segment({ text: "interim source must stay hidden" }),
        finals: [completedFinal],
      },
      "translation_only",
    ),
    translationOnlyText(completedFinal),
  );

  const pendingFinal = segment({ translationStatus: "pending", translationText: null });
  assert.deepEqual(
    selectOverlayCaption(
      {
        interim: null,
        finals: [pendingFinal],
      },
      "translation_only",
    ),
    translationOnlyText(pendingFinal),
  );
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
  assert.match(overlaySource, /overlayWindow\.startDragging\(\)/);
  assert.match(overlaySource, /overlayWindow\.startResizeDragging\("SouthEast"\)/);
  assert.doesNotMatch(overlaySource, /State|Time|Finals|revision|timeline|samples|等待实时字幕/);
  assert.ok(capability.permissions.includes("core:window:allow-start-dragging"));
  assert.ok(capability.permissions.includes("core:window:allow-start-resize-dragging"));
  const overlayWindow = tauriConfig.app.windows.find((window) => window.label === "caption-overlay");
  assert.equal(overlayWindow?.minWidth, 320);
});
