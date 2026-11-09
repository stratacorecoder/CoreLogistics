import { createHash } from "node:crypto";
import { one, run, tx } from "../../db.js";
import { conflict } from "../../errors.js";

export function normCode(value: string | undefined): string {
  return (value ?? "").trim().toUpperCase();
}

export function confirmationHash(parts: Array<string | null | undefined>): string {
  return createHash("sha256")
    .update(parts.map((part) => part ?? "").join("\u001f"))
    .digest("hex");
}

function readConfirmation<T>(requestId: string, hash: string): T | undefined {
  const row = one<{ input_hash: string; result_json: string }>(
    "SELECT input_hash, result_json FROM stock_confirmations WHERE request_id = ?",
    [requestId],
  );
  if (!row) return undefined;
  if (row.input_hash !== hash) throw conflict("Request id was already used with different input");
  return JSON.parse(row.result_json) as T;
}

function saveConfirmation(kind: "pick" | "putaway", taskId: string, requestId: string, hash: string, result: unknown) {
  run(
    `INSERT INTO stock_confirmations (request_id, task_kind, task_id, input_hash, result_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [requestId, kind, taskId, hash, JSON.stringify(result), new Date().toISOString()],
  );
}

function uniqueConstraint(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/i.test(err.message);
}

/** Runs `apply` once per request id. The saved result and the stock change commit together. */
export function confirmOnce<T>(
  kind: "pick" | "putaway",
  taskId: string,
  requestId: string,
  hash: string,
  apply: () => T,
): T {
  const prior = readConfirmation<T>(requestId, hash);
  if (prior) return prior;
  try {
    return tx(() => {
      const again = readConfirmation<T>(requestId, hash);
      if (again) return again;
      const result = apply();
      saveConfirmation(kind, taskId, requestId, hash, result);
      return result;
    });
  } catch (err) {
    if (!uniqueConstraint(err)) throw err;
    const saved = readConfirmation<T>(requestId, hash);
    if (saved) return saved;
    throw err;
  }
}
