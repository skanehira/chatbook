import { describe, it, expect, afterEach, vi } from "vite-plus/test";
import { render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { RouteErrorBoundary } from "./RouteErrorBoundary";

function Exploding(): never {
  throw new Error("Cannot read properties of undefined");
}

describe("RouteErrorBoundary", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("says the page broke instead of leaving a blank screen", async () => {
    // A throw while rendering is the one failure a Result cannot carry: React
    // unmounts the whole tree, and without a boundary the reader is left
    // looking at an empty document.
    vi.spyOn(console, "error").mockImplementation(() => {});
    const router = createMemoryRouter(
      [{ path: "/", element: <Exploding />, errorElement: <RouteErrorBoundary /> }],
      { initialEntries: ["/"] },
    );

    render(<RouterProvider router={router} />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /^表示中に問題が発生しました: Cannot read properties of undefined$/,
    );
    expect(screen.getByRole("link", { name: "本棚に戻る" })).toBeInTheDocument();
  });
});
