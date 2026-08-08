import { describe, it, expect, vi } from "vite-plus/test";
import { createStore } from "jotai";

const STORAGE_KEY = "chatbook:keybindings";

/**
 * The mode the reader starts a session with, given what the last one left in
 * storage. The atom reads storage when it is created, so each case needs the
 * module loaded again.
 */
async function restoredMode(stored: string | null) {
  localStorage.clear();
  if (stored !== null) localStorage.setItem(STORAGE_KEY, stored);
  vi.resetModules();
  const { keybindingModeAtom } = await import("./settingsAtom");
  return createStore().get(keybindingModeAtom);
}

describe("keybindingModeAtom", () => {
  it("restores the mode a previous session stored", async () => {
    expect(await restoredMode(JSON.stringify("emacs"))).toBe("emacs");
  });

  it("falls back to vim when storage holds a mode the reader has no bindings for", async () => {
    // resolveAction has no default branch, so an unknown mode makes it return
    // undefined and useKeyboardShortcuts throws on the first key pressed.
    expect(await restoredMode(JSON.stringify("dvorak"))).toBe("vim");
  });

  it("falls back to vim when storage holds something that is not a mode at all", async () => {
    expect(await restoredMode(JSON.stringify({ mode: "vim" }))).toBe("vim");
  });
});
