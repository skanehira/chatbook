/**
 * Why a service could not deliver what was asked of it.
 *
 * Two cases is all the routes need to tell apart: the thing is not there
 * (the caller asked for a book that was deleted), and the store the answer
 * lives in refused to answer. Everything routes do with a failure — the status
 * and the code they reply with — follows from that distinction alone.
 */
export type StorageError = { type: "STORAGE"; cause: unknown };

export type ServiceError = { type: "NOT_FOUND" } | StorageError;

export const notFound = (): ServiceError => ({ type: "NOT_FOUND" });

/** Wraps a rejection from D1 or R2, keeping the original for the server log. */
export const storageFailure = (cause: unknown): StorageError => ({ type: "STORAGE", cause });
