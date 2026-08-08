import { describe, it, expect, afterEach, vi } from "vite-plus/test";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SWRConfig, type Cache } from "swr";
import { FileSelector } from "./FileSelector";
import { bookKey } from "../../hooks/useBook";
import type { ExtractedPdfData } from "../../lib/pdfLoader";
import type { BookDetail } from "../../../shared/schemas/book";

const PDF_ID = "01JBOOK";
const FILE_NAME = "Cloudflare Workers.pdf";
const PAGE_COUNT = 209;

const COVER = new Blob(["webp bytes"], { type: "image/webp" });

const FULL_TEXT = "エッジはサーバーレス実行基盤です。";

function extraction(thumbnail: Blob | null): ExtractedPdfData {
  return {
    fileName: FILE_NAME,
    fileHash: "sha256-of-the-file",
    fullText: FULL_TEXT,
    pageCount: PAGE_COUNT,
    fileContentBase64: "",
    thumbnail,
  };
}

/** Answers the upload the way the API does, and records what it was sent. */
function uploadStub({ refuse = false } = {}) {
  const uploads: { url: string; method: string }[] = [];
  const fetchFn = (url: string, init?: RequestInit) => {
    uploads.push({ url, method: init?.method ?? "GET" });
    if (refuse) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            error: { code: "PDF_EXTRACT_FAILED", message: "Failed to process PDF" },
          }),
          { status: 500, headers: { "Content-Type": "application/json" } },
        ),
      );
    }
    const body = {
      id: PDF_ID,
      fileName: FILE_NAME,
      pageCount: PAGE_COUNT,
      fullText: FULL_TEXT,
    };
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  };
  return { uploads, fetchFn };
}

async function chooseAPdf(thumbnail: Blob | null, { refuse = false } = {}) {
  const { uploads, fetchFn } = uploadStub({ refuse });
  vi.stubGlobal("fetch", fetchFn);

  // The cache is built here rather than inside the provider so the test can
  // read what the upload filed in it.
  const cache: Cache = new Map();
  const opened: string[] = [];
  const failures: string[] = [];

  const { container } = render(
    <SWRConfig value={{ provider: () => cache }}>
      <FileSelector
        onOpened={(id) => opened.push(id)}
        onError={(message) => failures.push(message)}
        extract={async () => extraction(thumbnail)}
      />
    </SWRConfig>,
  );

  // The button is the affordance a reader sees; the input it clicks is hidden
  // and carries no name of its own, so it is reached by type.
  expect(screen.getByRole("button", { name: "PDFを開く" })).toBeInTheDocument();
  await userEvent.upload(
    container.querySelector<HTMLInputElement>('input[type="file"]')!,
    new File(["%PDF-1.7"], FILE_NAME, { type: "application/pdf" }),
  );

  return { cache, opened, uploads, failures };
}

describe("FileSelector", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("files the uploaded book under the key the reader opens it by", async () => {
    const { cache, opened } = await chooseAPdf(COVER);

    await waitFor(() => expect(opened).toStrictEqual([PDF_ID]));
    expect(cache.get(bookKey(PDF_ID))?.data).toStrictEqual({
      id: PDF_ID,
      fileName: FILE_NAME,
      pageCount: PAGE_COUNT,
      hasThumbnail: true,
      selections: [],
    } satisfies BookDetail);
  });

  it("records that a book whose cover could not be rendered has none", async () => {
    const { cache, opened } = await chooseAPdf(null);

    await waitFor(() => expect(opened).toStrictEqual([PDF_ID]));
    expect(cache.get(bookKey(PDF_ID))?.data).toStrictEqual({
      id: PDF_ID,
      fileName: FILE_NAME,
      pageCount: PAGE_COUNT,
      hasThumbnail: false,
      selections: [],
    } satisfies BookDetail);
  });

  it("hands up the reason an upload was refused rather than swallowing it", async () => {
    // The failure used to reach console.error only, so choosing a file the
    // server rejected looked exactly like choosing no file at all.
    const { cache, opened, failures } = await chooseAPdf(COVER, { refuse: true });

    await waitFor(() =>
      expect(failures).toStrictEqual(["PDFを開けませんでした: Failed to process PDF"]),
    );
    expect(opened).toStrictEqual([]);
    expect(cache.get(bookKey(PDF_ID))).toBeUndefined();
  });

  it("sends the chosen file to the endpoint that stores books", async () => {
    const { uploads } = await chooseAPdf(COVER);

    await waitFor(() => expect(uploads).toStrictEqual([{ url: "/api/pdf/open", method: "POST" }]));
  });
});
