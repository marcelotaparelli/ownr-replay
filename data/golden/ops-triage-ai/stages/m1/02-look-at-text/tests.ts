import { test, expect } from "replay:test";
import { classify } from "./classify.ts";

test('"production down" → INCIDENT', () => expect(classify("production down")).toBe("INCIDENT"));
test('"the server is down again" → INCIDENT', () => expect(classify("the server is down again")).toBe("INCIDENT"));
test('"lunch menu" → OTHER', () => expect(classify("lunch menu")).toBe("OTHER"));
test('texto vazio → OTHER', () => expect(classify("")).toBe("OTHER"));
