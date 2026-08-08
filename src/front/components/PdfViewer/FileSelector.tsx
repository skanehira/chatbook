import { useRef } from "react";
import { useAtom } from "jotai";
import { pdfDocAtom, pdfStatusAtom, pdfErrorAtom } from "../../atoms/pdfAtom";
import { extractPdfData } from "../../lib/pdfLoader";
import { fetcher } from "../../lib/fetcher";
import { pdfMetadataSchema } from "../../../shared/schemas/book";

interface FileSelectorProps {
  /** Called with the book id once the upload finished, so the caller can navigate. */
  onOpened?: (pdfId: string) => void;
  label?: string;
  className?: string;
}

export function FileSelector({ onOpened, label = "PDFを開く", className }: FileSelectorProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [, setPdfDoc] = useAtom(pdfDocAtom);
  const [, setPdfStatus] = useAtom(pdfStatusAtom);
  const [, setPdfError] = useAtom(pdfErrorAtom);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setPdfStatus("loading");
    setPdfError(null);

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

      setPdfDoc({
        id: result.id,
        fileName: result.fileName,
        pageCount: result.pageCount,
      });
      setPdfStatus("ready");
      onOpened?.(result.id);
    } catch (err) {
      setPdfError(err instanceof Error ? err.message : "Failed to load PDF");
      setPdfStatus("error");
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
