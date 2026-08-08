import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router";
import { SWRConfig } from "swr";
import "../index.css";
import { router } from "./routes";

/**
 * Nothing here changes behind the reader's back: the app is local, single-user,
 * and every book, highlight and message it shows was put there by this same
 * tab. Re-fetching on window focus would therefore never bring anything new —
 * it would only make what is on screen depend on when the window was clicked,
 * which is exactly what makes a browser test flaky.
 */
const swrOptions = { revalidateOnFocus: false };

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <SWRConfig value={swrOptions}>
      <RouterProvider router={router} />
    </SWRConfig>
  </StrictMode>,
);
