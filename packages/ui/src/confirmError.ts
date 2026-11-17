import { ApiError } from "./api.js";

export type ConfirmFailureKind = "wrong_label" | "stale" | "permission" | "network" | "server";

export interface ConfirmFailure {
  kind: ConfirmFailureKind;
  title: string;
  message: string;
  retry: boolean;
}

/** Separates a certain rejection from a result the client may not have received. */
export function classifyConfirmError(err: unknown): ConfirmFailure {
  if (!(err instanceof ApiError)) {
    return {
      kind: "network",
      title: "Network",
      message: "Connection failed. The codes are kept. Retry online with the same request.",
      retry: true,
    };
  }
  const message = err.message || "The server rejected the confirmation.";
  if (err.status === 401 || err.status === 403) {
    return { kind: "permission", title: "Permission", message, retry: false };
  }
  if (/^Wrong label/i.test(message)) {
    return { kind: "wrong_label", title: "Wrong label", message, retry: false };
  }
  if (/^Stale task/i.test(message)) {
    return { kind: "stale", title: "Stale task", message, retry: false };
  }
  if (err.status >= 500) {
    return {
      kind: "server",
      title: "Server",
      message: `${message} The codes are kept. Retry the same request.`,
      retry: true,
    };
  }
  return { kind: "server", title: "Server", message, retry: false };
}

export function newConfirmRequestId(): string {
  return crypto.randomUUID();
}
