import { createBrowserRouter, Navigate } from "react-router";
import { ShelfPage } from "./pages/ShelfPage";
import { AppPage } from "./pages/AppPage";
import { RouteErrorBoundary } from "./components/RouteErrorBoundary";

/**
 * Both pages carry the same boundary. A throw while rendering cannot be
 * reported as a value the way every other failure in this app is, so without
 * one the reader gets a blank document and no way back to the shelf.
 */
const errorElement = <RouteErrorBoundary />;

export const router = createBrowserRouter([
  { path: "/", element: <ShelfPage />, errorElement },
  { path: "/books/:pdfId", element: <AppPage />, errorElement },
  { path: "*", element: <Navigate to="/" replace /> },
]);
