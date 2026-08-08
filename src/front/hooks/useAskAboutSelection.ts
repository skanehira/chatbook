import { useCallback, useState } from "react";
import { useSetAtom } from "jotai";
import type { ResultAsync } from "neverthrow";
import { activeSelectionAtom, chatMessagesAtom } from "../atoms/chatAtom";
import { resultFetcher, type ApiError } from "../lib/fetcher";
import {
  createdSelectionSchema,
  type CreatedSelection,
  type PositionData,
} from "../../shared/schemas/selection";
import { useChatStream } from "./useChatStream";

/** A highlight the reader has just drawn, before the server has an id for it. */
export interface SelectionDraft {
  selectedText: string;
  pageNumber: number;
  /** Sent whole; the endpoint keeps only `rects` and `pageWidth`. */
  positionData: PositionData;
}

export type SaveSelection = (
  pdfId: string,
  draft: SelectionDraft,
) => ResultAsync<CreatedSelection, ApiError>;

const storeSelection: SaveSelection = (pdfId, draft) =>
  resultFetcher(`/api/pdf/${pdfId}/selections`, createdSelectionSchema, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(draft),
  });

/**
 * Turn a passage the reader has just marked into a highlight and a question
 * about it.
 *
 * The two steps are in that order for a reason: the answer is stored against
 * the highlight, so asking before the highlight exists would stream a reply
 * with nothing to hang it on. A failure to store therefore stops the ask, and
 * the caller is told so — the viewer keeps its popover open, with the question
 * still in it, rather than losing what the reader typed.
 */
export function useAskAboutSelection(
  addHighlight: (selection: CreatedSelection) => void,
  saveSelection: SaveSelection = storeSelection,
) {
  const setActiveSelection = useSetAtom(activeSelectionAtom);
  const setChatMessages = useSetAtom(chatMessagesAtom);
  const { sendMessage } = useChatStream();
  const [saveError, setSaveError] = useState<string | null>(null);

  const askAboutSelection = useCallback(
    (pdfId: string, draft: SelectionDraft, question: string, useWebSearch: boolean) => {
      setSaveError(null);

      return saveSelection(pdfId, draft)
        .andTee((selection) => {
          addHighlight(selection);
          setActiveSelection({
            id: selection.id,
            selectedText: selection.selectedText,
            pageNumber: selection.pageNumber,
          });
          setChatMessages([]);
          // The answer is not waited for. It takes seconds to arrive, and what
          // the caller is waiting on is whether the highlight was kept. The
          // stream reports its own failures through chatErrorAtom.
          void sendMessage(pdfId, selection.id, question, useWebSearch);
        })
        .orTee((failure) => {
          // Why it failed, in the server's words. The viewer writes the
          // sentence around it, as every other display of a failure does.
          setSaveError(failure.message);
        });
    },
    [addHighlight, saveSelection, sendMessage, setActiveSelection, setChatMessages],
  );

  return { askAboutSelection, saveError };
}
