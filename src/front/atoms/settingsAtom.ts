import { atomWithStorage, createJSONStorage } from "jotai/utils";
import { z } from "zod";
import type { KeybindingMode } from "../lib/keybindings";

const keybindingModeSchema = z.enum(["none", "vim", "emacs"]);

const jsonStorage = createJSONStorage<KeybindingMode>(() => localStorage);

/**
 * localStorage as a source of modes, with anything else treated as absent.
 *
 * The stored value is outside this app's control — an older release, another
 * tab, or the devtools can leave a string that is not a mode. `resolveAction`
 * has no default branch, so such a value makes it return undefined and the
 * shortcut hook throws while destructuring it, on the first key pressed.
 *
 * Written out rather than built with jotai's `unstable_withStorageValidator`,
 * which does the same thing: a setting that has to survive upgrades should not
 * hang off an API the library marks unstable.
 */
const keybindingModeStorage = {
  ...jsonStorage,
  getItem: (key: string, initialValue: KeybindingMode): KeybindingMode => {
    const stored = keybindingModeSchema.safeParse(jsonStorage.getItem(key, initialValue));
    return stored.success ? stored.data : initialValue;
  },
};

/** Persisted so the reader keeps the chosen bindings across sessions. */
export const keybindingModeAtom = atomWithStorage<KeybindingMode>(
  "chatbook:keybindings",
  "vim",
  keybindingModeStorage,
  { getOnInit: true },
);
