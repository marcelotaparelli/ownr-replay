import { test, expect } from "replay:test";
import { classify } from "./classify.ts";

test('"Production DOWN" → INCIDENT', () => expect(classify("Production DOWN")).toBe("INCIDENT"));
test('"Server Down" → INCIDENT', () => expect(classify("Server Down")).toBe("INCIDENT"));
test('"production down" → INCIDENT', () => expect(classify("production down")).toBe("INCIDENT"));
test('"Lunch Menu" → OTHER', () => expect(classify("Lunch Menu")).toBe("OTHER"));
