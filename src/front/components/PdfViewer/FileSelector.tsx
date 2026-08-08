import { useRef } from "react";
import { useSWRConfig } from "swr";
import { extractPdfData } from "../../lib/pdfLoader";
import { fetcher } from "../../lib/fetcher";
import { bookKey } from "../../hooks/useBook";
import { pdfMetadataSchema, type BookDetail } from "../../../shared/schemas/book";

interface FileSelectorProps {
  /** Called with the book id once the upload finished, so the caller can navigate. */
  onOpened?: (pdfId: string) => void;
  label?: string;
  className?: string;
}

export function FileSelector({ onOpened, label = "PDFを開く", className }: FileSelectorProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const { mutate } = useSWRConfig();

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      // Extract text and render the cover client-side (pdf.js)
      const extracted = await extractPdfData(file);

      // Send as multipart/form-data (avoids base64 overhead)
      const formData = new FormData();
      formData.append("file", file);
      formData.append("fullText", extracted.fullText);
      formData.append("pageCount", String(extracted.pageCount));
      if (extracted.thumbnail) {
        formData.append("thumbnail", extracted.thumbnail, "cover.webp");
      }

      const result = await fetcher("/api/pdf/open", pdfMetadataSchema, {
        method: "POST",
        body: formData,
      });

      // The upload already answered with everything the reader needs to open
      // the book, so hand it to the cache the reader reads from. Without this
      // the reader would show an empty viewer while it asked for the very
      // thing that was just sent. A fresh highlight list is right: the book
      // was uploaded, not annotated.
      const opened: BookDetail = {
        id: result.id,
        fileName: result.fileName,
        pageCount: result.pageCount,
        hasThumbnail: extracted.thumbnail !== null,
        selections: [],
      };
      await mutate(bookKey(result.id), opened, { revalidate: false });

      onOpened?.(result.id);
    } catch (err) {
      console.error("Failed to open the PDF:", err);
    } finally {
      // Allow selecting the same file again
      e.target.value = "";
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        className={
          className ??
          "px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium transition-colors cursor-pointer"
        }
      >
        {label}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf"
        onChange={handleFileChange}
        className="hidden"
      />
    </>
  );
}
