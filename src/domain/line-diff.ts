/**
 * "What is really new in this step": the line delta between two versions of a program.
 * Shared by the UI (green lines) and the curriculum validator (novelty budget), so what
 * the learner sees highlighted is exactly what the budget measures.
 */

/** Formatting-insensitive identity of a line. */
const normalize = (line: string): string => line.trim().replace(/\s+/g, " ");

/**
 * 1-based line numbers of `current` that did not exist in `previous`.
 * Longest common subsequence keeps stable lines stable; a line that only moved
 * (same text, new position) is not new either.
 */
export function addedLines(previous: string, current: string): number[] {
  const before = previous === "" ? [] : previous.split("\n").map(normalize);
  const after = current.split("\n").map(normalize);
  const matched = lcsMatches(before, after);

  const unmatchedBefore = new Map<string, number>();
  before.forEach((line, i) => {
    if (!matched.before.has(i)) unmatchedBefore.set(line, (unmatchedBefore.get(line) ?? 0) + 1);
  });

  const added: number[] = [];
  after.forEach((line, i) => {
    if (matched.after.has(i) || line === "") return;
    const moved = unmatchedBefore.get(line) ?? 0;
    if (moved > 0) {
      unmatchedBefore.set(line, moved - 1);
      return;
    }
    added.push(i + 1);
  });
  return added;
}

/** New lines that carry something to learn: not braces-only punctuation, not comments. */
export function noveltyLines(previous: string, current: string): number[] {
  const lines = current.split("\n");
  return addedLines(previous, current).filter((n) => {
    const text = (lines[n - 1] ?? "").trim();
    return !/^[{}()[\];,]*$/.test(text) && !text.startsWith("//");
  });
}

function lcsMatches(a: string[], b: string[]): { before: Set<number>; after: Set<number> } {
  // Prefix DP, then backtrack from the end: among equally long alignments, trailing lines
  // (a function's closing brace, the final return) keep their identity, as readers expect.
  // Programs in a micro stage are tens of lines, so O(n·m) is nothing.
  const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const row = table[i];
      const up = table[i - 1];
      if (!row || !up) continue;
      row[j] = a[i - 1] === b[j - 1] ? (up[j - 1] ?? 0) + 1 : Math.max(up[j] ?? 0, row[j - 1] ?? 0);
    }
  }
  const before = new Set<number>();
  const after = new Set<number>();
  let i = a.length;
  let j = b.length;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      before.add(--i);
      after.add(--j);
    } else if ((table[i - 1]?.[j] ?? 0) >= (table[i]?.[j - 1] ?? 0)) {
      i--;
    } else {
      j--;
    }
  }
  return { before, after };
}
