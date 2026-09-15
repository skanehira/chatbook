import { describe, it, expect } from "vite-plus/test";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { useChapters, chaptersKey, type LoadChapters } from "./useChapters";
import { SwrTestCache } from "../../test/swrTestCache";
import type { BookChapter } from "../../shared/schemas/book";

const PDF_ID = "01JBOOK";

const CHAPTERS: BookChapter[] = [
  { title: null, startPage: 1, endPage: 2 },
  { title: "第1章 テキストレイヤー", startPage: 3, endPage: 8 },
  { title: "第2章 チャットとの連携", startPage: 9, endPage: 12 },
];

function renderChapters(loadChapters: LoadChapters) {
  return renderHook(() => useChapters(PDF_ID, loadChapters), {
    // The key is module-level, so without a cache of its own one test would
    // read what another one filed.
    wrapper: ({ children }: { children: ReactNode }) => <SwrTestCache>{children}</SwrTestCache>,
  });
}

describe("useChapters", () => {
  it("hands back the chapters the server worked out, with the pages each covers", async () => {
    const { result } = renderChapters(() => Promise.resolve({ chapters: CHAPTERS }));

    await waitFor(() => expect(result.current.data).toStrictEqual({ chapters: CHAPTERS }));
  });

  it("asks under the id it files the answer by, so the two cannot drift", async () => {
    const asked: string[] = [];
    const { result } = renderChapters((pdfId) => {
      asked.push(pdfId);
      return Promise.resolve({ chapters: CHAPTERS });
    });

    await waitFor(() => expect(result.current.data).toBeDefined());

    expect(asked).toStrictEqual([PDF_ID]);
    expect(chaptersKey(PDF_ID)).toBe(`/api/pdf/${PDF_ID}/chapters`);
  });

  it("reports why when the chapters could not be read", async () => {
    const { result } = renderChapters(() => Promise.reject(new Error("PDF not found")));

    await waitFor(() => expect(result.current.error).toStrictEqual(new Error("PDF not found")));
    expect(result.current.data).toBeUndefined();
  });
});
