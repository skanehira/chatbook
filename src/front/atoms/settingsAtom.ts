import { atomWithStorage, createJSONStorage } from "jotai/utils";
import { z } from "zod";
import type { KeybindingMode } from "../lib/keybindings";

const keybindingModeSchema = z.enum(["none", "vim", "emacs"]);

const jsonStorage = createJSONStorage<KeybindingMode>(() => localStorage);

/** Anything that is not one of the modes is treated as nothing stored. */
function asMode(value: unknown, fallback: KeybindingMode): KeybindingMode {
  const parsed = keybindingModeSchema.safeParse(value);
  return parsed.success ? parsed.data : fallback;
}

/** Present whenever the environment can report another tab's writes. */
const subscribeToStorage = jsonStorage.subscribe;

/**
 * localStorage as a source of modes, with anything else treated as absent.
 *
 * The stored value is outside this app's control — an older release, another
 * tab, or the devtools can leave a string that is not a mode. `resolveAction`
 * has no default branch, so such a value makes it return undefined and the
 * shortcut hook throws while destructuring it, on the first key pressed.
 *
 * **Both ways in have to be checked.** A value read at startup arrives through
 * `getItem`, but a value another tab writes arrives through `subscribe`, which
 * parses the new string itself and never consults `getItem`. Checking only the
 * former leaves the session open to exactly the value it refused to start with.
 *
 * Written out rather than built with jotai's `unstable_withStorageValidator`,
 * which is both marked unstable and has that same gap: it replaces `getItem`
 * alone.
 */
const keybindingModeStorage = {
  ...jsonStorage,
  getItem: (key: string, initialValue: KeybindingMode): KeybindingMode =>
    asMode(jsonStorage.getItem(key, initialValue), initialValue),
  subscribe: subscribeToStorage
    ? (key: string, callback: (value: KeybindingMode) => void, initialValue: KeybindingMode) =>
        subscribeToStorage(key, (value) => callback(asMode(value, initialValue)), initialValue)
    : undefined,
};

/** Persisted so the reader keeps the chosen bindings across sessions. */
export const keybindingModeAtom = atomWithStorage<KeybindingMode>(
  "chatbook:keybindings",
  "vim",
  keybindingModeStorage,
  { getOnInit: true },
);
