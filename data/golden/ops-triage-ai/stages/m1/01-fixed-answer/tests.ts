import { test, expect } from "replay:test";
import { classify } from "./classify.ts";

test('classify("production down") → "INCIDENT"', () => {
  expect(classify("production down")).toBe("INCIDENT");
});
