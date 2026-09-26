/**
 * Minimal test runtime shared by every runner (browser worker, Docker image,
 * curriculum validator). Stage tests import it as `replay:test`.
 * No dependencies: it must run in a Web Worker and in a bare Bun container.
 */

export type TestOutcome = { name: string; passed: boolean; error?: string };

type TestFn = () => unknown;
type Matchers = {
  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
  toContain(item: unknown): void;
  toMatch(pattern: RegExp): void;
  toBeGreaterThan(n: number): void;
  toBeLessThan(n: number): void;
  toBeTruthy(): void;
  toBeFalsy(): void;
  toBeUndefined(): void;
  toBeInstanceOf(ctor: abstract new (...args: never[]) => unknown): void;
  toThrow(ctor?: abstract new (...args: never[]) => unknown): void;
};
type AsyncMatchers = { toBeInstanceOf(ctor: abstract new (...args: never[]) => unknown): Promise<void> };
export type Expect = (actual: unknown) => Matchers & { not: Matchers; rejects: AsyncMatchers };

export type Harness = {
  test: (name: string, fn: TestFn) => void;
  expect: Expect;
  run: (perTestTimeoutMs?: number) => Promise<TestOutcome[]>;
};

export class AssertionError extends Error {
  override readonly name = "AssertionError";
}

export function createHarness(): Harness {
  const registered: { name: string; fn: TestFn }[] = [];

  const test = (name: string, fn: TestFn): void => {
    registered.push({ name, fn });
  };

  const run = async (perTestTimeoutMs = 1_000): Promise<TestOutcome[]> => {
    const outcomes: TestOutcome[] = [];
    for (const { name, fn } of registered) {
      try {
        await withTimeout(Promise.resolve().then(fn), perTestTimeoutMs);
        outcomes.push({ name, passed: true });
      } catch (error) {
        outcomes.push({ name, passed: false, error: describeError(error) });
      }
    }
    return outcomes;
  };

  return { test, expect: createExpect(), run };
}

function createExpect(): Expect {
  return (actual) => ({
    ...matchers(actual, false),
    not: matchers(actual, true),
    rejects: {
      async toBeInstanceOf(ctor) {
        const promise = typeof actual === "function" ? (actual as () => unknown)() : actual;
        try {
          await promise;
        } catch (error) {
          if (error instanceof ctor) return;
          throw new AssertionError(`esperava rejeição com ${ctor.name}, recebeu ${describeError(error)}`);
        }
        throw new AssertionError(`esperava rejeição com ${ctor.name}, mas a promise resolveu`);
      },
    },
  });
}

function matchers(actual: unknown, negate: boolean): Matchers {
  const check = (ok: boolean, message: string): void => {
    if (ok === negate) throw new AssertionError((negate ? "não " : "") + message);
  };
  return {
    toBe: (expected) => check(Object.is(actual, expected), `esperava ${show(expected)}, recebeu ${show(actual)}`),
    toEqual: (expected) =>
      check(deepEqual(actual, expected), `esperava ${show(expected)}, recebeu ${show(actual)}`),
    toContain: (item) =>
      check(
        (typeof actual === "string" && typeof item === "string" && actual.includes(item)) ||
          (Array.isArray(actual) && actual.some((value) => deepEqual(value, item))),
        `esperava que ${show(actual)} contivesse ${show(item)}`,
      ),
    toMatch: (pattern) =>
      check(typeof actual === "string" && pattern.test(actual), `esperava ${show(actual)} casar com ${pattern}`),
    toBeGreaterThan: (n) => check(typeof actual === "number" && actual > n, `esperava ${show(actual)} > ${n}`),
    toBeLessThan: (n) => check(typeof actual === "number" && actual < n, `esperava ${show(actual)} < ${n}`),
    toBeTruthy: () => check(Boolean(actual), `esperava valor verdadeiro, recebeu ${show(actual)}`),
    toBeFalsy: () => check(!actual, `esperava valor falso, recebeu ${show(actual)}`),
    toBeUndefined: () => check(actual === undefined, `esperava undefined, recebeu ${show(actual)}`),
    toBeInstanceOf: (ctor) => check(actual instanceof ctor, `esperava instância de ${ctor.name}, recebeu ${show(actual)}`),
    toThrow: (ctor) => {
      let thrown: unknown;
      let didThrow = false;
      try {
        (actual as () => unknown)();
      } catch (error) {
        didThrow = true;
        thrown = error;
      }
      const ok = didThrow && (!ctor || thrown instanceof ctor);
      check(ok, ctor ? `esperava lançar ${ctor.name}` : "esperava lançar um erro");
    },
  };
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (a instanceof Set && b instanceof Set) return deepEqual([...a], [...b]);
  if (a instanceof Map && b instanceof Map) return deepEqual([...a], [...b]);
  const aKeys = Object.keys(a).filter((key) => (a as Record<string, unknown>)[key] !== undefined);
  const bKeys = Object.keys(b).filter((key) => (b as Record<string, unknown>)[key] !== undefined);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) =>
    deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
  );
}

function show(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    const json = JSON.stringify(value);
    if (json !== undefined) return json.length > 300 ? json.slice(0, 297) + "..." : json;
  } catch {
    // circular or otherwise unserialisable
  }
  return String(value);
}

export function describeError(error: unknown): string {
  if (error instanceof AssertionError) return error.message;
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`teste excedeu ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
