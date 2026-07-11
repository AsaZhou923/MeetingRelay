export const FIXTURE_LOGICAL_CLOCK_DOMAIN_ID =
  "meetingrelay.fixture.logical.v1";
export const NODE_HRTIME_SOURCE = "node.process.hrtime.bigint";

export function assertSafeRunId(runId) {
  if (
    typeof runId !== "string" ||
    runId.length === 0 ||
    runId !== runId.normalize("NFC") ||
    !/^[A-Za-z0-9-]+$/.test(runId)
  ) {
    throw new Error("run_id must be a non-empty safe NFC identifier");
  }
}

export function observationClockDomainId(runId) {
  assertSafeRunId(runId);
  return `node.hrtime.${runId}`;
}
