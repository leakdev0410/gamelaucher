import path from "node:path";

const normalizeForComparison = (value: string) => {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
};

/** Returns the resolved candidate only when it is a descendant of `root`. */
export const resolvePathWithinRoot = (
  root: string,
  candidate: string
): string | null => {
  const resolvedRoot = normalizeForComparison(root);
  const resolvedCandidate = normalizeForComparison(candidate);

  if (!resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`)) {
    return null;
  }

  return path.resolve(candidate);
};
