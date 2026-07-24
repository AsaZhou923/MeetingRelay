export interface TranscriptReconciliationPlan {
  insertions: string[];
  removals: string[];
  retained: string[];
}

function uniqueKeys(keys: readonly string[], label: string): Set<string> {
  const unique = new Set(keys);
  if (unique.size !== keys.length) {
    throw new Error(`duplicate transcript key in ${label}`);
  }
  return unique;
}

export function planTranscriptReconciliation(
  currentKeys: readonly string[],
  desiredKeys: readonly string[],
): TranscriptReconciliationPlan {
  const current = uniqueKeys(currentKeys, "current rows");
  const desired = uniqueKeys(desiredKeys, "desired rows");

  return {
    insertions: desiredKeys.filter((key) => !current.has(key)),
    removals: currentKeys.filter((key) => !desired.has(key)),
    retained: desiredKeys.filter((key) => current.has(key)),
  };
}
