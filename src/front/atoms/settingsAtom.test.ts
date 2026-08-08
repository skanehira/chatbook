import { describe, it, expect, vi, afterEach } from "vite-plus/test";
import { createStore } from "jotai";

const STORAGE_KEY = "chatbook:keybindings";
const WEB_SEARCH_KEY = "chatbook:web-search";

/**
 * Whether the assistant would search the web, given what the last session left
 * in storage. The reader builds a fresh jotai store for every book it opens, so
 * a setting that only lived in the store would go back to its default each
 * time; this is the same question asked of a brand new store.
 */
async function restoredWebSearch(stored: string) {
  localStorage.clear();
  localStorage.setItem(WEB_SEARCH_KEY, stored);
  vi.resetModules();
  const { useWebSearchAtom } = await import("./settingsAtom");
  return createStore().get(useWebSearchAtom);
}

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

/**
 * A session with the atom mounted, which is what makes it listen for the
 * storage events another tab's writes arrive as.
 */
async function openSession(stored: string) {
  localStorage.clear();
  localStorage.setItem(STORAGE_KEY, stored);
  vi.resetModules();
  const { keybindingModeAtom } = await import("./settingsAtom");
  const store = createStore();
  const unmount = store.sub(keybindingModeAtom, () => {});

  return {
    mode: () => store.get(keybindingModeAtom),
    writeFromAnotherTab: (value: unknown) => {
      const newValue = JSON.stringify(value);
      localStorage.setItem(STORAGE_KEY, newValue);
      window.dispatchEvent(
        new StorageEvent("storage", { key: STORAGE_KEY, newValue, storageArea: localStorage }),
      );
    },
    unmount,
  };
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

  it("follows another tab when it switches to a mode the reader has bindings for", async () => {
    const session = await openSession(JSON.stringify("vim"));

    session.writeFromAnotherTab("emacs");

    expect(session.mode()).toBe("emacs");
    session.unmount();
  });

  it("falls back to the default mode when another tab writes one the reader has no bindings for", async () => {
    // Checking storage only at startup would leave this open: the value
    // arrives on the storage event, which never goes through getItem.
    // Falling back to the default matches what a fresh session would do with
    // the same stored value.
    const session = await openSession(JSON.stringify("emacs"));

    session.writeFromAnotherTab("dvorak");

    expect(session.mode()).toBe("vim");
    session.unmount();
  });
});

describe("useWebSearchAtom", () => {
  it.each([
    { holds: "the setting turned off in a previous session", stored: "false", starts: false },
    { holds: "the setting turned back on", stored: "true", starts: true },
    { holds: "nothing this reader wrote", stored: JSON.stringify("yes"), starts: true },
  ])("starts $starts when storage holds $holds", async ({ stored, starts }) => {
    const useWebSearch = await restoredWebSearch(stored);

    expect(useWebSearch).toBe(starts);
  });

  it("is on for a reader who has never touched the setting", async () => {
    localStorage.clear();
    vi.resetModules();
    const { useWebSearchAtom } = await import("./settingsAtom");

    expect(createStore().get(useWebSearchAtom)).toBe(true);
  });
});
