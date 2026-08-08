import { Link, useRouteError } from "react-router";

/**
 * What a route shows when rendering it threw.
 *
 * Everything else in this app reports a failure as a value, but a throw during
 * render is not on that path: React tears the tree down and the reader is left
 * with a blank page and no way back. In a data router the `errorElement` is the
 * boundary, so this component is both.
 */
export function RouteErrorBoundary() {
  const error = useRouteError();
  const reason = error instanceof Error ? error.message : String(error);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-gray-50 p-6">
      <p role="alert" className="rounded-md bg-red-50 p-4 text-sm text-red-600">
        表示中に問題が発生しました: {reason}
      </p>
      <Link to="/" className="text-sm text-blue-600 hover:underline">
        本棚に戻る
      </Link>
    </div>
  );
}
