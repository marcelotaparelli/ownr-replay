import { describe, expect, test } from "bun:test";
import { clampWidth, clearWidth, saveWidth, storedWidth, type WidthStore } from "../web/panel-resize.ts";

function memoryStore(): WidthStore {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
}

describe("panel widths", () => {
  test("clamps width to a usable range, including when the viewport is too narrow", () => {
    expect(clampWidth(100, 180, 420)).toBe(180);
    expect(clampWidth(300, 180, 420)).toBe(300);
    expect(clampWidth(800, 180, 420)).toBe(420);
    expect(clampWidth(300, 180, 150)).toBe(180);
  });

  test("each panel persists independently and reset restores its default", () => {
    const store = memoryStore();
    expect(storedWidth(store, "journey", 232)).toBe(232);
    saveWidth(store, "journey", 311.6);
    saveWidth(store, "tutor", 455);
    expect(storedWidth(store, "journey", 232)).toBe(312);
    expect(storedWidth(store, "tutor", 360)).toBe(455);
    clearWidth(store, "journey");
    expect(storedWidth(store, "journey", 232)).toBe(232);
    expect(storedWidth(store, "tutor", 360)).toBe(455);
  });

  test("invalid or unavailable storage falls back without breaking the layout", () => {
    const store = memoryStore();
    store.setItem("journey", "invalid");
    expect(storedWidth(store, "journey", 232)).toBe(232);
    const blocked: WidthStore = { getItem: () => { throw Error("blocked"); }, setItem: () => { throw Error("blocked"); }, removeItem: () => { throw Error("blocked"); } };
    expect(storedWidth(blocked, "journey", 232)).toBe(232);
    expect(() => saveWidth(blocked, "journey", 300)).not.toThrow();
    expect(() => clearWidth(blocked, "journey")).not.toThrow();
  });
});
