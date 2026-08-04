import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  beginStartUiState,
  canBeginStart,
  finishStartUiState,
  mergeProbeStates,
  nextTranscriptFollowState,
  returnToLatest,
} from "./frontend-state.ts";

test("start state enters a running phase immediately", () => {
  assert.deepEqual(beginStartUiState(), {
    phase: "running",
    message: "正在检查设备和服务...",
  });
});

test("start guard blocks duplicate clicks while the first start is running", () => {
  assert.equal(canBeginStart(beginStartUiState()), false);
  assert.equal(canBeginStart(finishStartUiState(false, "设备不可用")), true);
});

test("start state preserves an actionable failure message", () => {
  assert.deepEqual(finishStartUiState(false, "设备不可用"), {
    phase: "error",
    message: "设备不可用",
  });
});

test("provider probe state survives profile refresh for retained profiles", () => {
  const previous = new Map([
    [
      "cloud",
      {
        profileId: "cloud",
        phase: "success",
        message: "连接成功",
        latencyMs: 42,
        updatedAtMs: 10,
      },
    ],
    [
      "removed",
      {
        profileId: "removed",
        phase: "error",
        message: "连接失败",
        latencyMs: null,
        updatedAtMs: 11,
      },
    ],
  ]);

  assert.deepEqual(Array.from(mergeProbeStates(previous, [{ profileId: "cloud" }]).keys()), [
    "cloud",
  ]);
  assert.equal(mergeProbeStates(previous, [{ profileId: "cloud" }]).get("cloud")?.message, "连接成功");
});

test("provider probe state survives a reordered settings refresh", () => {
  const previous = new Map([
    [
      "b",
      {
        profileId: "b",
        phase: "success",
        message: "连接成功",
        latencyMs: 31,
        updatedAtMs: 10,
      },
    ],
  ]);

  const refreshed = mergeProbeStates(previous, [{ profileId: "a" }, { profileId: "b" }]);
  assert.equal(refreshed.get("b")?.latencyMs, 31);
});

test("transcript follow state counts unseen rows while user is reading history", () => {
  assert.deepEqual(
    nextTranscriptFollowState({
      followLatest: false,
      wasAtBottom: false,
      insertedCount: 2,
      previousUnseenCount: 1,
    }),
    {
      followLatest: false,
      unseenCount: 3,
      showJumpButton: true,
      announcement: "有 3 条新内容，点击“回到最新”继续跟随。",
    },
  );
});

test("transcript follow state clears unseen rows at the bottom", () => {
  assert.deepEqual(
    nextTranscriptFollowState({
      followLatest: false,
      wasAtBottom: true,
      insertedCount: 2,
      previousUnseenCount: 4,
    }),
    {
      followLatest: true,
      unseenCount: 0,
      showJumpButton: false,
      announcement: "正在跟随最新内容。",
    },
  );
});

test("returning to latest clears unseen rows", () => {
  assert.deepEqual(returnToLatest(), {
    followLatest: true,
    unseenCount: 0,
    showJumpButton: false,
    announcement: "正在跟随最新内容。",
  });
});

test("main source defines three primary navigation tabs outside the live transcript", () => {
  const source = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
  assert.match(source, /data-view="live"[^>]*>实时会议/);
  assert.match(source, /data-view="records"[^>]*>会议记录/);
  assert.match(source, /data-view="settings"[^>]*>设置/);
  const transcriptStageStart = source.indexOf('<section class="transcript-stage"');
  const transcriptStageEnd = source.indexOf("</section>", source.indexOf("</footer>", transcriptStageStart));
  const consoleStart = source.indexOf('<section class="r3r4-console"');
  assert.ok(transcriptStageStart >= 0);
  assert.ok(transcriptStageEnd > transcriptStageStart);
  assert.ok(consoleStart > transcriptStageEnd);
});
