export function canonicalizeJson(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalizeJson);
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalizeJson(value[key])]),
    );
  }

  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new TypeError("canonical JSON cannot encode a non-finite number");
  }

  return typeof value === "string" ? value.normalize("NFC") : value;
}

export function encodeCanonicalJson(value) {
  return `${JSON.stringify(canonicalizeJson(value), null, 2)}\n`;
}

export function encodeCanonicalJsonLine(value) {
  return `${JSON.stringify(canonicalizeJson(value))}\n`;
}
