import { test, expect } from "replay:test";
import { classify } from "./classify.ts";

test('"down" na descrição → INCIDENT', () => expect(classify({ title: "Checkout", description: "the site is down" })).toBe("INCIDENT"));
test('"DOWN" no título → INCIDENT', () => expect(classify({ title: "Site DOWN", description: "" })).toBe("INCIDENT"));
test('sem "down" → OTHER', () => expect(classify({ title: "Lunch", description: "menu for friday" })).toBe("OTHER"));
