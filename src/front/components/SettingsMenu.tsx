// oxlint-disable-next-line no-restricted-imports -- document への keydown / mousedown 購読 (Escape と外側クリックで閉じる) に必要
import { useState, useRef, useEffect } from "react";
import { useAtom } from "jotai";
import { keybindingModeAtom } from "../atoms/settingsAtom";
import { useWebSearchAtom } from "../atoms/settingsAtom";
import { KEYBINDING_HELP, type KeybindingMode } from "../lib/keybindings";

const MODE_LABELS: Record<KeybindingMode, string> = {
  none: "なし",
  vim: "Vim",
  emacs: "Emacs",
};

export function SettingsMenu() {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useAtom(keybindingModeAtom);
  const [useWebSearch, setUseWebSearch] = useAtom(useWebSearchAtom);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false);
    };

    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("mousedown", handleClick);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("mousedown", handleClick);
    };
  }, [open]);

  const help = mode === "none" ? null : KEYBINDING_HELP[mode];

  return (
    <div ref={menuRef} className="relative">
      <button
        type="button"
        aria-label="設定"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="rounded px-2 py-1 text-lg leading-none text-gray-600 hover:bg-gray-200 cursor-pointer"
      >
        ⚙
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 w-64 rounded-lg border border-gray-200 bg-white p-3 shadow-xl">
          <fieldset className="mb-3 border-b border-gray-100 pb-3">
            <legend className="mb-2 text-xs font-semibold text-gray-500">チャット</legend>
            <label className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-sm text-gray-700 hover:bg-gray-50">
              <input
                type="checkbox"
                checked={useWebSearch}
                onChange={(e) => setUseWebSearch(e.target.checked)}
                className="h-3.5 w-3.5"
              />
              Web検索
            </label>
          </fieldset>

          <fieldset>
            <legend className="mb-2 text-xs font-semibold text-gray-500">キーバインド</legend>
            <div className="flex flex-col gap-1">
              {(Object.keys(MODE_LABELS) as KeybindingMode[]).map((value) => (
                <label
                  key={value}
                  className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-sm text-gray-700 hover:bg-gray-50"
                >
                  <input
                    type="radio"
                    name="keybinding-mode"
                    value={value}
                    checked={mode === value}
                    onChange={() => setMode(value)}
                    className="h-3.5 w-3.5"
                  />
                  {MODE_LABELS[value]}
                </label>
              ))}
            </div>
          </fieldset>

          {help && (
            <dl className="mt-3 border-t border-gray-100 pt-2 text-xs text-gray-600">
              {help.map(([keys, description]) => (
                <div key={keys} className="flex items-baseline justify-between py-0.5">
                  <dt>
                    <kbd className="rounded border border-gray-300 bg-gray-50 px-1.5 py-0.5 font-mono text-[11px]">
                      {keys}
                    </kbd>
                  </dt>
                  <dd>{description}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      )}
    </div>
  );
}
