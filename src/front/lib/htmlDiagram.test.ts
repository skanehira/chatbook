import { describe, it, expect } from "vite-plus/test";
import { asStandaloneDocument, captionFromMeta } from "./htmlDiagram";

describe("captionFromMeta", () => {
  it("reads the caption a fence names in its info string", () => {
    expect(captionFromMeta('title="シーケンス図"')).toBe("シーケンス図");
  });

  it("keeps the quotes out of a caption written in single quotes", () => {
    expect(captionFromMeta("title='Two workers'")).toBe("Two workers");
  });

  it("reads a caption that was left unquoted", () => {
    expect(captionFromMeta("title=flowchart")).toBe("flowchart");
  });

  it("names no caption when the info string is not a title", () => {
    expect(captionFromMeta("no-highlight")).toBeNull();
    expect(captionFromMeta(undefined)).toBeNull();
  });
});

describe("asStandaloneDocument", () => {
  it("gives a document that arrived without a doctype one", () => {
    expect(asStandaloneDocument("<div>A → B</div>")).toBe("<!doctype html>\n<div>A → B</div>");
  });

  it("leaves a document that names its own doctype alone", () => {
    const document = "<!DOCTYPE html>\n<html><body>A</body></html>";

    expect(asStandaloneDocument(document)).toBe(document);
  });
});
