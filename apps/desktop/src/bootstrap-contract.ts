export const BOOTSTRAP_CONTRACT_VERSION = "meetingrelay.phase0.bootstrap.v1";

export type BootstrapProbeResult = {
  contractVersion: string;
  workerNs: string;
  outputNs: string;
  endToEndNs: string;
};

const UINT64_MAX = 18_446_744_073_709_551_615n;
const CANONICAL_UNSIGNED_DECIMAL = /^(?:0|[1-9][0-9]*)$/;
const RESULT_FIELDS = [
  "contractVersion",
  "workerNs",
  "outputNs",
  "endToEndNs",
] as const;

const nanosecondFormatter = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0,
  useGrouping: true,
});

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function parseUint64Decimal(field: string, value: unknown): string {
  if (typeof value !== "string" || !CANONICAL_UNSIGNED_DECIMAL.test(value)) {
    throw new Error(`${field} must be a canonical unsigned decimal string.`);
  }

  if (BigInt(value) > UINT64_MAX) {
    throw new Error(`${field} exceeds the uint64 range.`);
  }

  return value;
}

export function parseBootstrapProbe(value: unknown): BootstrapProbeResult {
  if (!isPlainObject(value)) {
    throw new Error("Bootstrap probe response must be a plain object.");
  }

  const keys = Object.keys(value);
  if (
    keys.length !== RESULT_FIELDS.length ||
    keys.some((key) => !RESULT_FIELDS.includes(key as (typeof RESULT_FIELDS)[number]))
  ) {
    throw new Error("Bootstrap probe response fields do not match the contract.");
  }

  if (value.contractVersion !== BOOTSTRAP_CONTRACT_VERSION) {
    throw new Error("Bootstrap probe contract version is not supported.");
  }

  return {
    contractVersion: value.contractVersion,
    workerNs: parseUint64Decimal("workerNs", value.workerNs),
    outputNs: parseUint64Decimal("outputNs", value.outputNs),
    endToEndNs: parseUint64Decimal("endToEndNs", value.endToEndNs),
  };
}

export function formatNanoseconds(value: string): string {
  const parsed = parseUint64Decimal("nanoseconds", value);
  return `${nanosecondFormatter.format(BigInt(parsed))} ns`;
}
