import { test, expect } from "ownr:test";
import { classify } from "./classify.ts";

test('classify("production down") → "INCIDENT"', () => expect(classify("production down")).toBe("INCIDENT"));
