import assert from "node:assert/strict";
import test from "node:test";

import {
  BOOTSTRAP_CONTRACT_VERSION,
  formatNanoseconds,
  parseBootstrapProbe,
} from "./bootstrap-contract.ts";

const validProbe = {
  contractVersion: BOOTSTRAP_CONTRACT_VERSION,
  workerNs: "24000",
  outputNs: "21000",
  endToEndNs: "45000",
};

test("parses and formats the fixed bootstrap probe", () => {
  assert.deepEqual(parseBootstrapProbe(validProbe), validProbe);
  assert.equal(formatNanoseconds(validProbe.workerNs), "24,000 ns");
  assert.equal(formatNanoseconds(validProbe.outputNs), "21,000 ns");
  assert.equal(formatNanoseconds(validProbe.endToEndNs), "45,000 ns");
});

test("rejects JavaScript numbers for nanoseconds", () => {
  assert.throws(
    () => parseBootstrapProbe({ ...validProbe, workerNs: 24_000 }),
    /canonical unsigned decimal string/,
  );
});

test("rejects non-canonical leading zeros", () => {
  assert.throws(
    () => parseBootstrapProbe({ ...validProbe, outputNs: "021000" }),
    /canonical unsigned decimal string/,
  );
});

test("rejects values above uint64", () => {
  assert.throws(
    () =>
      parseBootstrapProbe({
        ...validProbe,
        endToEndNs: "18446744073709551616",
      }),
    /exceeds the uint64 range/,
  );
});

test("rejects an unknown contract version", () => {
  assert.throws(
    () => parseBootstrapProbe({ ...validProbe, contractVersion: "future" }),
    /contract version is not supported/,
  );
});
