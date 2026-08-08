import { describe, it, expect, vi, afterEach } from "vite-plus/test";
import { createStore } from "jotai";

const STORAGE_KEY = "chatbook:keybindings";

/**
 * The mode the reader starts a session with, given what the last one left in
 * storage. The atom reads storage when it is created, so each case needs the
 * module loaded again.
 */
async function restoredMode(stored: string) {
  localStorage.clear();
  localStorage.setItem(STORAGE_KEY, stored);
  vi.resetModules();
  const { keybindingModeAtom } = await import("./settingsAtom");
  return createStore().get(keybindingModeAtom);
}

afterEach(() => {
  localStorage.clear();
});

describe("keybindingModeAtom", () => {
  // Anything that is not a mode has to come back as the default: resolveAction
  // has no default branch, so an unknown mode makes it return undefined and
  // useKeyboardShortcuts throws on the first key pressed.
  it.each([
    {
      holds: "a mode a previous session stored",
      stored: JSON.stringify("emacs"),
      starts: "emacs",
    },
    {
      holds: "a mode the reader has no bindings for",
      stored: JSON.stringify("dvorak"),
      starts: "vim",
    },
    {
      holds: "something that is not a mode at all",
      stored: JSON.stringify({ mode: "vim" }),
      starts: "vim",
    },
  ])("starts in $starts when storage holds $holds", async ({ stored, starts }) => {
    const mode = await restoredMode(stored);

    expect(mode).toBe(starts);
  });
});
