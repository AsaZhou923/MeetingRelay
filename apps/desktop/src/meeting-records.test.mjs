import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import { createContext, Script } from "node:vm";

import * as frontendState from "./frontend-state.ts";
import * as contract from "./mvp-contract.ts";
import * as transcriptRender from "./transcript-render.ts";

// Execute the real module, including its markup and event handlers. Only imports
// (provided below) and startup IPC are omitted; no production functions are copied
// or replaced. This exercises UI wiring without a WebView or new dependencies.
const mainSource = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
const bootstrapStart = mainSource.lastIndexOf("\napplyAppPreference();");
assert.notEqual(bootstrapStart, -1, "main.ts startup boundary must be identifiable");
const mainScript = new Script(
  stripTypeScriptTypes(
    mainSource.slice(0, bootstrapStart).replace(/^import[\s\S]*?;\n/gm, ""),
  ),
  { filename: "main.ts" },
);

const dataKey = (name) => name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());

// A deliberately small DOM: real module markup creates the elements, so missing
// IDs and broken selector/event wiring fail instead of being silently stubbed.
class ElementStub {
  constructor(tagName, ownerDocument) {
    this.tagName = tagName.toLowerCase();
    this.ownerDocument = ownerDocument;
    this.parentElement = null;
    this.childNodes = [];
    this.attributes = new Map();
    this.dataset = {};
    this.style = {};
    this.listeners = new Map();
    this.disabled = false;
    this.checked = false;
    this.hidden = false;
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.clientHeight = 0;
  }

  get children() {
    const children = this.childNodes.filter((child) => child instanceof ElementStub);
    children.item = (index) => children[index] ?? null;
    return children;
  }
  get id() { return this.attributes.get("id") ?? ""; }
  set id(value) { this.attributes.set("id", value); }
  get className() { return this.attributes.get("class") ?? ""; }
  set className(value) { this.attributes.set("class", value); }
  get value() {
    return this._value ?? (this.tagName === "select" ? this.children[0]?.value : undefined) ?? "";
  }
  set value(value) { this._value = String(value); }
  get textContent() {
    return this.childNodes.map((child) => typeof child === "string" ? child : child.textContent).join("");
  }
  set textContent(value) { this.replaceChildren(String(value ?? "")); }
  set innerHTML(html) { this.replaceChildren(); this.insertAdjacentHTML("beforeend", html); }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name.startsWith("data-")) this.dataset[dataKey(name)] = String(value);
    if (name === "value") this.value = value;
    if (["disabled", "checked", "hidden"].includes(name)) this[name] = true;
  }
  getAttribute(name) {
    return name.startsWith("data-")
      ? this.dataset[dataKey(name)] ?? null
      : this.attributes.get(name) ?? null;
  }
  append(...nodes) {
    for (const node of nodes) {
      if (node instanceof ElementStub) {
        node.remove();
        node.parentElement = this;
      }
      this.childNodes.push(node);
    }
  }
  replaceChildren(...nodes) {
    for (const child of this.children) child.parentElement = null;
    this.childNodes = [];
    this.append(...nodes);
  }
  remove() {
    if (this.parentElement) {
      const siblings = this.parentElement.childNodes;
      siblings.splice(siblings.indexOf(this), 1);
      this.parentElement = null;
    }
  }
  insertBefore(node, before) {
    if (before === null) return this.append(node);
    node.remove();
    node.parentElement = this;
    this.childNodes.splice(this.childNodes.indexOf(before), 0, node);
  }
  insertAdjacentHTML(position, html) {
    assert.equal(position, "beforeend");
    const stack = [this];
    const voidTags = new Set(["input", "br", "hr", "img", "meta", "link"]);
    for (const token of html.match(/<[^>]+>|[^<]+/g) ?? []) {
      if (token.startsWith("<!--")) continue;
      if (token.startsWith("</")) { stack.pop(); continue; }
      if (!token.startsWith("<")) { stack.at(-1).append(token); continue; }
      const [, tag, attrs] = token.match(/^<([\w-]+)([\s\S]*?)\/?\s*>$/);
      const element = this.ownerDocument.createElement(tag);
      for (const match of attrs.matchAll(/([\w:-]+)(?:\s*=\s*"([^"]*)")?/g)) {
        element.setAttribute(match[1], match[2] ?? "");
      }
      stack.at(-1).append(element);
      if (!voidTags.has(tag) && !token.endsWith("/>")) stack.push(element);
    }
  }
  matches(selector) {
    if (selector.startsWith("#")) return this.id === selector.slice(1);
    if (selector.startsWith(".")) return this.className.split(/\s+/).includes(selector.slice(1));
    const match = selector.match(/^(\w+)?(?:\[([^=\]]+)(?:="([^"]*)")?\])?(:checked)?$/);
    assert.ok(match, `Unsupported test DOM selector: ${selector}`);
    return (!match[1] || this.tagName === match[1]) &&
      (!match[2] || (match[3] === undefined
        ? this.getAttribute(match[2]) !== null
        : this.getAttribute(match[2]) === match[3])) &&
      (!match[4] || this.checked);
  }
  querySelectorAll(selector) {
    const parts = selector.trim().split(/\s+/);
    const result = [];
    for (const child of this.children) {
      if (child.matches(parts[0])) {
        if (parts.length === 1) result.push(child);
        else result.push(...child.querySelectorAll(parts.slice(1).join(" ")));
      }
      result.push(...child.querySelectorAll(selector));
    }
    return [...new Set(result)];
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  closest(selector) {
    for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node;
    return null;
  }
  addEventListener(type, callback) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(callback);
    this.listeners.set(type, listeners);
  }
  async dispatch(type) {
    if (type === "click" && this.disabled) return;
    await Promise.all((this.listeners.get(type) ?? []).map((callback) =>
      callback({ target: this, preventDefault() {} })));
  }
  focus(options) { this.ownerDocument.activeElement = this; this.focusOptions = options; }
  scrollIntoView(options) { this.scrollOptions = options; }
}

function createHarness() {
  const document = {
    activeElement: null,
    createElement(tag) { return new ElementStub(tag, this); },
    querySelector(selector) { return this.body.querySelector(selector); },
    querySelectorAll(selector) { return this.body.querySelectorAll(selector); },
  };
  document.body = document.createElement("body");
  const app = document.createElement("div");
  app.id = "app";
  document.body.append(app);
  const handlers = new Map();
  const calls = [];
  const timers = new Map();
  let timerId = 0;
  const context = createContext({
    ...frontendState, ...contract, ...transcriptRender,
    document, console, URL, Error,
    HTMLElement: ElementStub, HTMLLIElement: ElementStub,
    CSS: { escape: (value) => value },
    window: {
      setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
      clearTimeout(id) { timers.delete(id); },
      addEventListener() {},
      confirm() { return true; },
      localStorage: { getItem() { return null; }, setItem() {} },
    },
    listen: async () => () => {},
    invoke: async (command, args) => {
      calls.push({ command, args });
      assert.ok(handlers.has(command), `Unexpected IPC command ${command}`);
      return handlers.get(command)(args);
    },
  });
  mainScript.runInContext(context);
  const run = (source) => new Script(source).runInContext(context);
  return {
    document, calls, timers,
    controls: run("controls"),
    run,
    set(name, value) {
      context.__value = value;
      run(`${name} = __value`);
      delete context.__value;
    },
    on(command, handler) { handlers.set(command, handler); },
    fireTimer(id) {
      const timer = timers.get(id);
      assert.ok(timer, `Expected pending timer ${id}`);
      timers.delete(id);
      return timer.callback();
    },
  };
}

const timestamp = "2026-10-17T00:00:00Z";
function segment(sequence) {
  return {
    segmentId: `segment-${sequence}`, sequence: String(sequence), revision: 1,
    isFinal: true, saved: true, text: `Original ${sequence}`,
    startedAtMs: String(sequence * 1000), endedAtMs: String(sequence * 1000 + 900),
    committedAt: timestamp, commitId: `commit-${sequence}`,
    meetingSampleStart: String(sequence * 16000), meetingSampleEnd: String(sequence * 16000 + 14400),
    timelineRevision: 1, translationStatus: "completed", translationTarget: "en",
    translationText: `Translation ${sequence}`, translationError: null,
  };
}
function summary(meetingId) {
  return {
    summaryId: `summary-${meetingId}`, version: 1, language: "zh",
    overview: `Saved ${meetingId} overview`, actions: [`${meetingId} action`],
    decisions: [`${meetingId} decision`], openQuestions: [`${meetingId} question`],
    citations: [{ segmentId: "segment-1", sequence: "1", label: `${meetingId} citation` }],
    createdAt: timestamp,
  };
}
function detail(meetingId = "meeting-a", count = 1, savedSummary = null) {
  return {
    meeting: {
      meetingId, title: meetingId, status: "completed", startedAt: timestamp, updatedAt: timestamp,
      durationMs: String(count * 1000), language: "zh", savedFinalCount: String(count),
      translationFailedCount: 0, summaryStatus: savedSummary ? "completed" : "idle", tags: [],
    },
    segments: Array.from({ length: count }, (_, index) => segment(index + 1)),
    transcriptComplete: true, summary: savedSummary,
  };
}
function snapshot(overrides = {}) {
  const source = (id) => ({ id, label: id, ready: true, active: false, frames: "0", peak: 0, status: "ready", error: null });
  return {
    contractVersion: "mvp-v1", lifecycle: "ready", modelReady: true, modelLabel: "Test model",
    localOnly: true, memoryOnly: false, meetingId: null, sessionId: null, durabilityStatus: "ready",
    savedFinalCount: "0", totalFinalCount: "0", visibleFinalWindowStartSequence: "0", lastSavedSequence: null,
    latestOpenedMeeting: null, availableExports: [], elapsedMs: "0",
    system: source("system"), microphone: source("microphone"), interim: null, finals: [],
    queueDepth: 0, translationQueueDepth: 0,
    disk: { status: "ok", dataDir: "C:\\MeetingRelay", freeBytes: "10000000000", requiredBytes: "1000", warning: null },
    error: null, ...overrides,
  };
}
function job(meetingId, status = "queued", overrides = {}) {
  return {
    jobId: `job-${meetingId}`, meetingId, status, version: 1,
    totalChunks: 1, completedChunks: status === "completed" ? 1 : 0,
    canCancel: ["queued", "chunking", "combining"].includes(status),
    canRetry: ["failed", "cancelled"].includes(status), message: null,
    result: status === "completed" ? summary(meetingId) : null, ...overrides,
  };
}
const localProvider = {
  profileId: "local-test", label: "Test local provider", class: "local",
  baseUrl: "http://127.0.0.1:11434/v1", model: "test", policyUrl: null,
  dataFlow: "Local test", configVersion: 1, secretState: "not_required",
  lastTestStatus: "passed", lastTestAt: timestamp, lastError: null,
};
function recordsHarness(records = [detail("meeting-a"), detail("meeting-b")]) {
  const h = createHarness();
  const recordsById = new Map(records.map((record) => [record.meeting.meetingId, record]));
  h.on("mvp_meeting_detail", ({ meetingId }) => {
    assert.ok(recordsById.has(meetingId), `Missing fixture for ${meetingId}`);
    return recordsById.get(meetingId);
  });
  h.on("mvp_speaker_latest", () => null);
  h.set("providerProfiles", [localProvider]);
  h.controls.summaryProvider.value = localProvider.profileId;
  return h;
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const load = (h, id, segmentId = null, sequence = null) =>
  h.run(`loadMeetingDetail(${JSON.stringify(id)}, ${JSON.stringify(segmentId)}, ${JSON.stringify(sequence)})`);
const displayedSequences = (h) => h.controls.detailSegments.children.map((row) => row.dataset.sequence);

for (const count of [200, 201]) {
  test(`#9: ${count} segments render a bounded first page in stable order`, async () => {
    const h = recordsHarness([detail("meeting-a", count)]);
    await load(h, "meeting-a");
    assert.deepEqual(displayedSequences(h), Array.from({ length: 200 }, (_, i) => String(i + 1)));
    assert.match(h.controls.detailSegments.children[199].textContent, /Original 200/);
    assert.match(h.controls.detailSegments.children[199].textContent, /Translation 200/);
    assert.match(h.controls.detailSegments.children[199].textContent, /说话人：未分配/);
  });
}

test("#9: an exact search target beyond page one is rendered, scrolled and focused", async () => {
  const h = recordsHarness([detail("meeting-a", 601)]);
  await load(h, "meeting-a", "segment-601", "601");
  const target = h.controls.detailSegments.querySelector('[data-segment-id="segment-601"]');
  assert.ok(target);
  assert.equal(h.document.activeElement, target);
  assert.equal(target.dataset.focused, "true");
  assert.equal(target.scrollOptions.block, "center");
  assert.equal(target.focusOptions.preventScroll, true);
  assert.ok(h.controls.detailSegments.children.length <= 200);
  assert.match(target.textContent, /Original 601/);
  assert.match(target.textContent, /Translation 601/);
});

test("#9: the sequence input reaches 201 then returns to the first page", async () => {
  const h = recordsHarness([detail("meeting-a", 401)]);
  await load(h, "meeting-a");
  for (const sequence of ["201", "1"]) {
    h.controls.detailSequence.value = sequence;
    await h.controls.detailSequence.dispatch("change");
    assert.equal(h.document.activeElement.dataset.sequence, sequence);
    assert.equal(h.document.activeElement.dataset.focused, "true");
    assert.equal(h.controls.detailSegments.querySelectorAll("[data-focused]").length, 1);
  }
});

test("#10: selecting a complete historical record after restart enables record actions", async () => {
  const h = recordsHarness();
  h.set("latest", snapshot());
  await load(h, "meeting-a");
  assert.equal(h.run("selectedMeetingId()"), "meeting-a");
  assert.equal(h.controls.exportSelected.disabled, false);
  assert.equal(h.controls.summaryStart.disabled, false);
  assert.equal(h.controls.deletePreview.disabled, false);
  assert.equal(h.controls.exportAll.disabled, true, "live-session export is still independent");
  assert.equal(h.controls.copyTranscript.disabled, true, "live-session copy is still independent");
});

test("#10: no record and no live meeting keep record actions disabled", () => {
  const h = recordsHarness();
  h.set("latest", snapshot());
  h.run("renderExports(latest)");
  for (const control of ["exportSelected", "summaryStart", "deletePreview"]) {
    assert.equal(h.controls[control].disabled, true, control);
  }
});

for (const lifecycle of ["starting", "recording", "paused", "stopping"]) {
  test(`#10: global ${lifecycle} blocks historical record actions`, async () => {
    const h = recordsHarness();
    h.set("latest", snapshot({ lifecycle, meetingId: "live-meeting", durabilityStatus: "recording" }));
    await load(h, "meeting-a");
    for (const control of ["exportSelected", "summaryStart", "deletePreview"]) {
      assert.equal(h.controls[control].disabled, true, control);
    }
  });
}

test("#11: reopening a record restores all sections of its saved structured summary", async () => {
  const h = recordsHarness([detail("meeting-a", 1, summary("meeting-a"))]);
  await load(h, "meeting-a");
  for (const expected of ["概览", "行动项", "决定", "待确认问题", "引用", "Saved meeting-a overview", "meeting-a action", "meeting-a decision", "meeting-a question", "meeting-a citation"]) {
    assert.ok(h.controls.summaryOutput.textContent.includes(expected), expected);
  }
  assert.equal(h.controls.summaryCancel.disabled, true);
  assert.equal(h.controls.summaryRetry.disabled, true);
});

test("#11: switching records restores B's summary and an empty B never shows A's result", async () => {
  for (const bSummary of [summary("meeting-b"), null]) {
    const h = recordsHarness([detail("meeting-a", 1, summary("meeting-a")), detail("meeting-b", 1, bSummary)]);
    await load(h, "meeting-a");
    await load(h, "meeting-b");
    assert.doesNotMatch(h.controls.summaryOutput.textContent, /meeting-a/);
    if (bSummary) assert.match(h.controls.summaryOutput.textContent, /Saved meeting-b overview/);
    else assert.match(h.controls.summaryOutput.textContent, /暂无|无摘要/);
    assert.equal(h.controls.summaryCancel.disabled, true);
    assert.equal(h.controls.summaryRetry.disabled, true);
  }
});

test("#9: previous/next controls expose every page and preserve ordered segment labels", async () => {
  const h = recordsHarness([detail("meeting-a", 401)]);
  h.on("mvp_speaker_latest", () => ({
    meetingId: "meeting-a", version: 1, parentVersion: null, algorithm: "test",
    digest: "a".repeat(64), createdAt: timestamp, operation: "diarize",
    identities: [{ speakerId: "speaker-1", displayName: "Alex" }],
    assignments: [{ segmentId: "segment-201", sequence: "201", sourceRevision: 1, speakerId: "speaker-1", confidence: 0.95 }],
  }));
  await load(h, "meeting-a");
  assert.equal(h.controls.detailPrevious.disabled, true);
  assert.equal(h.controls.detailNext.disabled, false);
  assert.match(h.controls.detailPageStatus.textContent, /1\/3/);
  assert.match(h.controls.detailPageStatus.textContent, /401/);
  await h.controls.detailNext.dispatch("click");
  assert.deepEqual(displayedSequences(h), Array.from({ length: 200 }, (_, i) => String(i + 201)));
  assert.match(h.controls.detailSegments.children[0].textContent, /说话人：Alex · 置信度 95%/);
  assert.match(h.controls.detailSegments.children[0].textContent, /Original 201/);
  assert.match(h.controls.detailSegments.children[0].textContent, /Translation 201/);
  assert.match(h.controls.detailPageStatus.textContent, /2\/3/);
  await h.controls.detailNext.dispatch("click");
  assert.deepEqual(displayedSequences(h), ["401"]);
  assert.equal(h.controls.detailNext.disabled, true);
  await h.controls.detailPrevious.dispatch("click");
  assert.equal(displayedSequences(h)[0], "201");
  assert.equal(displayedSequences(h).at(-1), "400");
});

test("#9: 200 has no next page, while 201 exposes the final row through next", async () => {
  for (const count of [200, 201]) {
    const h = recordsHarness([detail("meeting-a", count)]);
    await load(h, "meeting-a");
    assert.equal(h.controls.detailNext.disabled, count === 200);
    if (count === 201) {
      await h.controls.detailNext.dispatch("click");
      assert.deepEqual(displayedSequences(h), ["201"]);
      assert.equal(h.controls.detailNext.disabled, true);
      assert.equal(h.controls.detailPrevious.disabled, false);
    }
  }
});

test("#9: clicking a rendered search hit opens and focuses a later-page segment", async () => {
  const h = recordsHarness([detail("meeting-a", 401)]);
  h.set("searchPage", {
    hits: [{ meetingId: "meeting-a", meetingTitle: "A", segmentId: "segment-401", sequence: "401", scope: "original", snippet: "Original 401", score: 1 }],
    nextCursor: null, total: 1, elapsedMs: 1,
  });
  h.run("renderSearchResults()");
  await h.controls.searchResults.children[0].querySelector("button").dispatch("click");
  assert.equal(h.document.activeElement.dataset.segmentId, "segment-401");
  assert.equal(h.document.activeElement.dataset.focused, "true");
});

test("#9: noncontiguous sequence IDs jump by the target's position, not its numeric value", async () => {
  const record = detail("meeting-a", 201);
  record.segments[200] = { ...segment(999), sequence: "999" };
  const h = recordsHarness([record]);
  await load(h, "meeting-a", "segment-999", "999");
  assert.equal(h.document.activeElement.dataset.sequence, "999");
  assert.match(h.controls.detailPageStatus.textContent, /2\/2/);
  const before = displayedSequences(h);
  h.controls.detailSequence.value = "does-not-exist";
  await h.controls.detailSequence.dispatch("change");
  assert.deepEqual(displayedSequences(h), before, "an invalid target must not erase the current page");
});

for (const [name, mutate] of [
  ["an incomplete durable transcript", (record) => { record.transcriptComplete = false; }],
  ["a segment count mismatch", (record) => { record.meeting.savedFinalCount = "2"; }],
  ["pending translation", (record) => { Object.assign(record.segments[0], { translationStatus: "pending", translationText: null }); }],
  ["an errored record", (record) => { record.meeting.status = "error"; }],
  ["an empty record", (record) => { record.segments = []; record.meeting.savedFinalCount = "0"; }],
]) {
  test(`#10: ${name} cannot be exported or summarized`, async () => {
    const record = detail();
    mutate(record);
    const h = recordsHarness([record]);
    h.set("latest", snapshot());
    await load(h, "meeting-a");
    assert.equal(h.controls.exportSelected.disabled, true);
    assert.equal(h.controls.summaryStart.disabled, true);
    assert.equal(h.controls.deletePreview.disabled, false, "safe delete preview remains available for unusable records");
    await h.run("startSummaryJob()");
    assert.equal(h.calls.some(({ command }) => command === "mvp_summary_start"), false);
  });
}

test("#10: a valid record still requires a selected summary provider", async () => {
  const h = recordsHarness();
  h.set("latest", snapshot());
  await load(h, "meeting-a");
  h.controls.summaryProvider.value = "";
  await h.controls.summaryProvider.dispatch("change");
  assert.equal(h.controls.summaryStart.disabled, true);
  assert.equal(h.controls.exportSelected.disabled, false);
  assert.equal(h.controls.deletePreview.disabled, false);
});

test("#10: switching records disables actions while detail IPC is unresolved", async () => {
  const h = recordsHarness();
  h.set("latest", snapshot());
  await load(h, "meeting-a");
  const response = deferred();
  h.on("mvp_meeting_detail", () => response.promise);
  const pendingLoad = load(h, "meeting-b");
  assert.equal(h.run("selectedMeetingId()"), null);
  for (const name of ["exportSelected", "summaryStart", "deletePreview"]) {
    assert.equal(h.controls[name].disabled, true, name);
  }
  response.resolve(detail("meeting-b"));
  await pendingLoad;
  assert.equal(h.controls.exportSelected.disabled, false);
});

test("#11: selecting B clears A's visible summary immediately, before B's IPC returns", async () => {
  const h = recordsHarness([detail("meeting-a", 1, summary("meeting-a"))]);
  await load(h, "meeting-a");
  const response = deferred();
  h.on("mvp_meeting_detail", () => response.promise);
  const pendingLoad = load(h, "meeting-b");
  assert.doesNotMatch(h.controls.summaryOutput.textContent, /meeting-a/);
  assert.match(h.controls.summaryOutput.textContent, /读取|加载/);
  assert.equal(h.controls.summaryCancel.disabled, true);
  assert.equal(h.controls.summaryRetry.disabled, true);
  response.resolve(detail("meeting-b", 1, summary("meeting-b")));
  await pendingLoad;
  assert.match(h.controls.summaryOutput.textContent, /Saved meeting-b overview/);
});

test("#11: a late A detail response cannot replace the selected B record or summary", async () => {
  const h = recordsHarness();
  const aResponse = deferred();
  h.on("mvp_meeting_detail", ({ meetingId }) => meetingId === "meeting-a"
    ? aResponse.promise : detail("meeting-b", 1, summary("meeting-b")));
  const pendingA = load(h, "meeting-a");
  await load(h, "meeting-b");
  aResponse.resolve(detail("meeting-a", 1, summary("meeting-a")));
  await pendingA;
  assert.equal(h.run("selectedMeetingId()"), "meeting-b");
  assert.match(h.controls.summaryOutput.textContent, /Saved meeting-b overview/);
  assert.doesNotMatch(h.controls.detailSummary.textContent, /meeting-a/);
});

test("#11: A→B→A ignores the first A detail response after the latest A has loaded", async () => {
  const h = recordsHarness();
  const oldA = deferred();
  let aLoads = 0;
  h.on("mvp_meeting_detail", ({ meetingId }) => {
    if (meetingId === "meeting-a" && ++aLoads === 1) return oldA.promise;
    return detail(meetingId, 1, { ...summary(meetingId), overview: `Newest ${meetingId}` });
  });
  const firstA = load(h, "meeting-a");
  await load(h, "meeting-b");
  await load(h, "meeting-a");
  oldA.resolve(detail("meeting-a", 1, { ...summary("meeting-a"), overview: "Stale A" }));
  await firstA;
  assert.match(h.controls.summaryOutput.textContent, /Newest meeting-a/);
  assert.doesNotMatch(h.controls.summaryOutput.textContent, /Stale A/);
});

async function startJob(h, meetingId = "meeting-a", status = "queued") {
  h.set("latest", snapshot());
  await load(h, meetingId);
  h.on("mvp_summary_start", () => job(meetingId, status));
  await h.controls.summaryStart.dispatch("click");
  assert.equal(h.run("selectedSummaryJob()?.jobId"), `job-${meetingId}`);
}

for (const operation of ["start", "cancel", "retry"]) {
  test(`#11: a delayed ${operation} stays bound to A while B is selected`, async () => {
    const h = recordsHarness([detail("meeting-a"), detail("meeting-b", 1, summary("meeting-b"))]);
    if (operation === "start") { h.set("latest", snapshot()); await load(h, "meeting-a"); }
    else await startJob(h, "meeting-a", operation === "retry" ? "failed" : "queued");
    const response = deferred();
    const command = `mvp_summary_${operation}`;
    h.on(command, () => response.promise);
    const control = h.controls[{ start: "summaryStart", cancel: "summaryCancel", retry: "summaryRetry" }[operation]];
    const pending = control.dispatch("click");
    assert.equal(control.disabled, true, "prevent a duplicate command while its IPC is pending");
    const sent = h.calls.filter((call) => call.command === command).at(-1);
    assert.equal(operation === "start" ? sent.args.meetingId : sent.args.jobId,
      operation === "start" ? "meeting-a" : "job-meeting-a");
    if (operation !== "cancel") {
      assert.equal(sent.args.providerProfileId, localProvider.profileId);
      assert.equal(sent.args.summaryRiskAccepted, true);
    }
    await load(h, "meeting-b");
    response.resolve(job("meeting-a", operation === "cancel" ? "cancelled" : "completed"));
    await pending;
    assert.equal(h.run("selectedMeetingId()"), "meeting-b");
    assert.equal(h.run("selectedSummaryJob()"), null);
    assert.match(h.controls.summaryOutput.textContent, /Saved meeting-b overview/);
    assert.doesNotMatch(h.controls.summaryOutput.textContent, /meeting-a/);
    assert.equal(h.controls.summaryCancel.disabled, true);
    assert.equal(h.controls.summaryRetry.disabled, true);
    await load(h, "meeting-a");
    assert.equal(h.run("selectedSummaryJob().meetingId"), "meeting-a");
    if (operation === "cancel") assert.equal(h.controls.summaryRetry.disabled, false);
    else assert.match(h.controls.summaryOutput.textContent, /Saved meeting-a overview/);
  });
}

for (const operation of ["start", "cancel", "retry"]) {
  test(`#11: a stale ${operation} error cannot overwrite B or a reopened A summary`, async () => {
    const h = recordsHarness([detail("meeting-a", 1, summary("meeting-a")), detail("meeting-b", 1, summary("meeting-b"))]);
    if (operation === "start") { h.set("latest", snapshot()); await load(h, "meeting-a"); }
    else await startJob(h, "meeting-a", operation === "retry" ? "failed" : "queued");
    const response = deferred();
    h.on(`mvp_summary_${operation}`, () => response.promise);
    const pending = h.run(operation === "start" ? "startSummaryJob()" : `updateSummaryJob("mvp_summary_${operation}")`);
    await load(h, "meeting-b");
    assert.match(h.controls.summaryOutput.textContent, /Saved meeting-b overview/);
    await load(h, "meeting-a");
    response.reject(new Error(`stale-${operation}-error`));
    await pending;
    assert.doesNotMatch(h.controls.summaryOutput.textContent, /stale-.*-error|摘要操作失败/);
    assert.equal(h.run("selectedMeetingId()"), "meeting-a");
  });
}

test("#11: an in-flight A poll cannot replace B's summary and returning to A resumes its own job", async () => {
  const h = recordsHarness([detail("meeting-a"), detail("meeting-b", 1, summary("meeting-b"))]);
  await startJob(h);
  const response = deferred();
  h.on("mvp_summary_status", () => response.promise);
  const pendingPoll = h.fireTimer(h.run("summaryPollTimer"));
  assert.equal(h.calls.at(-1).args.jobId, "job-meeting-a");
  await load(h, "meeting-b");
  response.resolve(job("meeting-a", "completed"));
  await pendingPoll;
  assert.match(h.controls.summaryOutput.textContent, /Saved meeting-b overview/);
  assert.equal(h.run("selectedSummaryJob()"), null);
  assert.equal(h.timers.size, 0, "A must not keep polling while B is displayed");
  await load(h, "meeting-a");
  assert.equal(h.run("selectedSummaryJob().status"), "queued", "stale poll result was discarded");
  h.on("mvp_summary_status", () => job("meeting-a", "completed"));
  await h.fireTimer(h.run("summaryPollTimer"));
  assert.match(h.controls.summaryOutput.textContent, /Saved meeting-a overview/);
  assert.equal(h.timers.size, 0, "completed jobs stop polling");
});

test("#11: A→B→A rejects an old poll response even after a newer A poll succeeds", async () => {
  const h = recordsHarness();
  await startJob(h);
  const oldResponse = deferred();
  h.on("mvp_summary_status", () => oldResponse.promise);
  const oldPoll = h.fireTimer(h.run("summaryPollTimer"));
  await load(h, "meeting-b");
  await load(h, "meeting-a");
  h.on("mvp_summary_status", () => job("meeting-a", "completed", {
    result: { ...summary("meeting-a"), version: 2, overview: "New A result" }, version: 2,
  }));
  await h.fireTimer(h.run("summaryPollTimer"));
  oldResponse.resolve(job("meeting-a", "completed", {
    result: { ...summary("meeting-a"), overview: "Stale A result" },
  }));
  await oldPoll;
  assert.match(h.controls.summaryOutput.textContent, /New A result/);
  assert.doesNotMatch(h.controls.summaryOutput.textContent, /Stale A result/);
  assert.equal(h.run("selectedSummaryJob().version"), 2);
  assert.equal(h.timers.size, 0);
});

test("#11: an A→B→A stale poll failure cannot overwrite the current A view", async () => {
  const h = recordsHarness();
  await startJob(h);
  const response = deferred();
  h.on("mvp_summary_status", () => response.promise);
  const poll = h.fireTimer(h.run("summaryPollTimer"));
  await load(h, "meeting-b");
  await load(h, "meeting-a");
  const currentTimer = h.run("summaryPollTimer");
  response.reject(new Error("stale-poll-error"));
  await poll;
  assert.doesNotMatch(h.controls.summaryOutput.textContent, /stale-poll-error|读取摘要状态失败/);
  assert.equal(h.run("summaryPollTimer"), currentTimer);
  assert.equal(h.timers.has(currentTimer), true);
});

test("#11: a late poll cannot undo a newer cancellation of the same job", async () => {
  const h = recordsHarness();
  await startJob(h);
  const response = deferred();
  h.on("mvp_summary_status", () => response.promise);
  const poll = h.fireTimer(h.run("summaryPollTimer"));
  h.on("mvp_summary_cancel", () => job("meeting-a", "cancelled"));
  await h.controls.summaryCancel.dispatch("click");
  response.resolve(job("meeting-a", "chunking"));
  await poll;
  assert.equal(h.run("selectedSummaryJob().status"), "cancelled");
  assert.equal(h.controls.summaryCancel.disabled, true);
  assert.equal(h.controls.summaryRetry.disabled, false);
  assert.equal(h.timers.size, 0);
});

for (const navigate of ["page", "jump"]) {
  test(`#9: delayed speaker metadata preserves a user ${navigate} made during loading`, async () => {
    const h = recordsHarness([detail("meeting-a", 601)]);
    const speakers = deferred();
    const requested = deferred();
    h.on("mvp_speaker_latest", () => { requested.resolve(); return speakers.promise; });
    const pendingLoad = load(h, "meeting-a", "segment-601", "601");
    await requested.promise;
    assert.equal(h.document.activeElement.dataset.sequence, "601");
    if (navigate === "page") await h.controls.detailPrevious.dispatch("click");
    else {
      h.controls.detailSequence.value = "201";
      await h.controls.detailSequence.dispatch("change");
    }
    const selectedPage = displayedSequences(h);
    speakers.resolve(null);
    await pendingLoad;
    assert.deepEqual(displayedSequences(h), selectedPage);
    if (navigate === "jump") {
      assert.equal(h.document.activeElement.dataset.sequence, "201");
      assert.equal(h.controls.detailSegments.querySelector('[data-focused="true"]'), h.document.activeElement);
    }
  });
}

test("#11: failed meeting detail IPC leaves an actionable error and clears loading text", async () => {
  const h = recordsHarness();
  h.set("latest", snapshot());
  h.on("mvp_meeting_detail", () => { throw new Error("Database unavailable"); });
  await load(h, "meeting-a");
  assert.match(h.controls.libraryStatus.textContent, /读取会议失败/);
  assert.match(h.controls.libraryStatus.textContent, /Database unavailable/);
  assert.doesNotMatch(h.controls.detailSummary.textContent, /正在读取|加载/);
  assert.doesNotMatch(h.controls.summaryOutput.textContent, /正在读取|加载/);
  assert.equal(h.run("detailLoading"), false);
  for (const name of ["exportSelected", "summaryStart", "deletePreview"]) assert.equal(h.controls[name].disabled, true);
});

test("#11: full snapshot rendering switches fallback A→B summary and stops A's timer", () => {
  const h = recordsHarness();
  h.run("summaryJobs").set("meeting-a", job("meeting-a"));
  h.run("summaryJobs").set("meeting-b", job("meeting-b", "completed"));
  h.run(`render(${JSON.stringify(snapshot({ meetingId: "meeting-a" }))})`);
  assert.equal(h.run("selectedRecordId"), null);
  assert.equal(h.run("selectedSummaryJob().meetingId"), "meeting-a");
  assert.equal(h.timers.size, 1);
  h.run(`render(${JSON.stringify(snapshot({ meetingId: "meeting-b" }))})`);
  assert.equal(h.run("selectedSummaryJob().meetingId"), "meeting-b");
  assert.match(h.controls.summaryOutput.textContent, /Saved meeting-b overview/);
  assert.equal(h.timers.size, 0);
  h.run(`render(${JSON.stringify(snapshot())})`);
  assert.equal(h.run("selectedSummaryJob()"), null);
  assert.doesNotMatch(h.controls.summaryOutput.textContent, /meeting-b/);
});

test("#10: declining cloud-provider consent prevents the summary IPC command", async () => {
  const h = recordsHarness();
  h.set("latest", snapshot());
  h.set("providerProfiles", [{ ...localProvider, class: "cloud", policyUrl: "https://example.com/privacy" }]);
  h.run("window.confirm = () => false");
  await load(h, "meeting-a");
  await h.controls.summaryStart.dispatch("click");
  assert.equal(h.calls.some(({ command }) => command === "mvp_summary_start"), false);
  assert.equal(h.controls.summaryStart.disabled, false);
});

test("#11: delayed tag-save detail cannot replace B's detail or saved summary", async () => {
  const h = recordsHarness([detail("meeting-a"), detail("meeting-b", 1, summary("meeting-b"))]);
  await load(h, "meeting-a");
  const response = deferred();
  h.on("mvp_update_meeting_tags", () => response.promise);
  h.controls.detailTags.value = "important";
  const pending = h.run("saveMeetingTags()");
  assert.equal(h.calls.at(-1).args.meetingId, "meeting-a");
  await load(h, "meeting-b");
  response.resolve({ ...detail("meeting-a", 1, summary("meeting-a")), meeting: { ...detail().meeting, tags: ["important"] } });
  await pending;
  assert.equal(h.run("selectedMeetingId()"), "meeting-b");
  assert.match(h.controls.detailSummary.textContent, /meeting-b/);
  assert.match(h.controls.summaryOutput.textContent, /Saved meeting-b overview/);
  assert.equal(h.controls.detailTags.value, "");
});

test("#11: a delayed speaker refresh for A cannot contaminate B's speaker state", async () => {
  const h = recordsHarness();
  await load(h, "meeting-a");
  const response = deferred();
  const version = (meetingId, name) => ({
    meetingId, version: 1, parentVersion: null, algorithm: "test", digest: "b".repeat(64),
    createdAt: timestamp, operation: "diarize", identities: [{ speakerId: "speaker-1", displayName: name }],
    assignments: [{ segmentId: "segment-1", sequence: "1", sourceRevision: 1, speakerId: "speaker-1", confidence: 0.9 }],
  });
  h.on("mvp_speaker_latest", ({ meetingId }) => meetingId === "meeting-a" ? response.promise : version("meeting-b", "Bea"));
  const pending = h.run("refreshSpeakerVersion()");
  await load(h, "meeting-b");
  response.resolve(version("meeting-a", "Alex"));
  await pending;
  assert.equal(h.run("speakerVersion.meetingId"), "meeting-b");
  assert.equal(h.run("latestSpeakerVersion.meetingId"), "meeting-b");
  assert.match(h.controls.detailSegments.textContent, /说话人：Bea/);
  assert.doesNotMatch(h.controls.detailSegments.textContent, /Alex/);
});

test("#10: a new global recording immediately disables retry for a selected failed summary", async () => {
  const h = recordsHarness();
  await startJob(h, "meeting-a", "failed");
  assert.equal(h.controls.summaryRetry.disabled, false);
  h.run(`render(${JSON.stringify(snapshot({ lifecycle: "recording", meetingId: "live-meeting", durabilityStatus: "recording" }))})`);
  assert.equal(h.controls.summaryRetry.disabled, true);
  await h.run('updateSummaryJob("mvp_summary_retry")');
  assert.equal(h.calls.some(({ command }) => command === "mvp_summary_retry"), false);
});

test("#9: the initial delayed speaker read cannot erase a newer same-meeting refresh", async () => {
  const h = recordsHarness();
  const initialResponse = deferred();
  const requested = deferred();
  let reads = 0;
  h.on("mvp_speaker_latest", () => {
    if (++reads === 1) { requested.resolve(); return initialResponse.promise; }
    return {
      meetingId: "meeting-a", version: 2, parentVersion: 1, algorithm: "test",
      digest: "c".repeat(64), createdAt: timestamp, operation: "refresh",
      identities: [], assignments: [],
    };
  });
  const pendingLoad = load(h, "meeting-a");
  await requested.promise;
  await h.run("refreshSpeakerVersion()");
  assert.equal(h.run("speakerVersion.version"), 2);
  initialResponse.resolve(null);
  await pendingLoad;
  assert.equal(h.run("speakerVersion.version"), 2);
  assert.equal(h.run("latestSpeakerVersion.version"), 2);
  assert.equal(h.controls.speakerVersion.textContent, "2");
});

for (const [name, finalState, enabled] of [
  ["completed", { durabilityStatus: "completed", error: null, translationQueueDepth: 0 }, true],
  ["interrupted with an error", { durabilityStatus: "interrupted", error: "INCOMPLETE_TRANSCRIPT", translationQueueDepth: 0 }, false],
]) {
  test(`#10: a fresher same-meeting ${name} snapshot controls record action eligibility`, async () => {
    const record = detail("meeting-a");
    record.meeting.status = "recording";
    Object.assign(record.segments[0], { translationStatus: "pending", translationText: null });
    const h = recordsHarness([record]);
    h.set("latest", snapshot({ lifecycle: "recording", meetingId: "meeting-a", durabilityStatus: "recording", translationQueueDepth: 1 }));
    await load(h, "meeting-a");
    assert.equal(h.controls.exportSelected.disabled, true);
    assert.equal(h.controls.summaryStart.disabled, true);
    assert.equal(h.controls.deletePreview.disabled, true);
    h.run(`render(${JSON.stringify(snapshot({
      meetingId: "meeting-a", lifecycle: "ready", savedFinalCount: "1", totalFinalCount: "1",
      lastSavedSequence: "1", finals: [segment(1)], availableExports: [...contract.MVP_EXPORT_FORMATS],
      ...finalState,
    }))})`);
    assert.equal(h.run("meetingDetail.meeting.status"), "recording", "the record detail is deliberately stale");
    assert.equal(h.controls.exportSelected.disabled, !enabled);
    assert.equal(h.controls.summaryStart.disabled, !enabled);
    assert.equal(h.controls.deletePreview.disabled, false, "inactive meetings can still be previewed for deletion");
    assert.equal(h.controls.exportAll.disabled, !enabled);
    assert.equal(h.controls.copyTranscript.disabled, !enabled);
  });
}

test("#10: an explicit same-meeting incomplete detail veto survives a ready completed snapshot", async () => {
  const record = detail("meeting-a");
  record.transcriptComplete = false;
  const h = recordsHarness([record]);
  h.set("latest", snapshot({
    meetingId: "meeting-a", lifecycle: "ready", durabilityStatus: "completed", error: null,
    savedFinalCount: "1", totalFinalCount: "1", lastSavedSequence: "1", finals: [segment(1)],
    translationQueueDepth: 0, availableExports: [...contract.MVP_EXPORT_FORMATS],
  }));
  await load(h, "meeting-a");
  h.run("render(latest)");
  assert.equal(h.controls.exportSelected.disabled, true);
  assert.equal(h.controls.summaryStart.disabled, true);
  assert.equal(h.controls.deletePreview.disabled, false);
  await h.run("startSummaryJob()");
  assert.equal(h.calls.some(({ command }) => command === "mvp_summary_start"), false);
});

test("#11: selected summary content and export version use the newest completed result", async () => {
  const h = recordsHarness([detail("meeting-a", 1, summary("meeting-a")), detail("meeting-b")]);
  await load(h, "meeting-a");
  const newer = job("meeting-a", "completed");
  newer.version = 2;
  newer.result.version = 2;
  newer.result.overview = "New completed summary";
  h.run("summaryJobs").set("meeting-a", newer);
  h.run("renderSummaryJob()");
  assert.equal(h.run("selectedSummaryResult().version"), 2);
  assert.match(h.controls.summaryOutput.textContent, /New completed summary/);
  await load(h, "meeting-b");
  assert.equal(h.run("selectedSummaryResult()"), null);
  assert.doesNotMatch(h.controls.summaryOutput.textContent, /New completed summary/);
});
