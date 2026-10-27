import type { ErrorRequestHandler, RequestHandler } from "express";

type ErrorBody = {
  code: string;
  message: string;
  details?: unknown;
};

function sendError(
  res: Parameters<ErrorRequestHandler>[2],
  status: number,
  body: ErrorBody,
): void {
  res.status(status).json(body);
}

/**
 * Express JSON parser errors use `type` (from body-parser), not a bare SyntaxError.
 * Only treat those as "malformed JSON" — other SyntaxErrors may come from app code.
 */
function isMalformedJsonError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "type" in err &&
    (err as { type?: string }).type === "entity.parse.failed"
  );
}

function isBodyTooLargeError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "type" in err &&
    (err as { type?: string }).type === "entity.too.large"
  );
}

/** Catch-all for unexpected failures. Never expose stack traces to clients. */
export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (isMalformedJsonError(err)) {
    sendError(res, 400, {
      code: "INVALID_JSON",
      message: "Request body contains malformed JSON",
    });
    return;
  }

  if (isBodyTooLargeError(err)) {
    sendError(res, 413, {
      code: "PAYLOAD_TOO_LARGE",
      message: "Request body exceeds the 100 KB size limit",
    });
    return;
  }

  console.error("Unhandled error:", err instanceof Error ? err.message : "unknown");

  sendError(res, 500, {
    code: "INTERNAL_ERROR",
    message: "An unexpected error occurred",
  });
};

/** 404 for unknown routes — keeps response shape consistent with other errors. */
export const notFoundHandler: RequestHandler = (_req, res) => {
  sendError(res, 404, {
    code: "NOT_FOUND",
    message: "Route not found",
  });
};
