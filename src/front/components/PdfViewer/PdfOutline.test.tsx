import { describe, it, expect } from "vite-plus/test";
import { render, screen } from "@testing-library/react";
import { PdfOutline } from "./PdfOutline";

describe("PdfOutline", () => {
  it("says the table of contents could not be read rather than showing the book as having none", () => {
    render(
      <PdfOutline
        outline={null}
        error="Invalid outline destination"
        currentPage={1}
        onJump={() => {}}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      /^目次を読み込めませんでした: Invalid outline destination$/,
    );
  });

  it("says a book without a table of contents has none", () => {
    render(<PdfOutline outline={[]} error={null} currentPage={1} onJump={() => {}} />);

    expect(screen.getByText("この本には目次がありません")).toBeInTheDocument();
  });
});
