import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ApiError } from "./api.js";
import { classifyConfirmError } from "./confirmError.js";

describe("Confirmation errors", () => {
  it("keeps the same request retryable after a lost connection or a server failure", () => {
    const offline = classifyConfirmError(new TypeError("Failed to fetch"));
    assert.equal(offline.kind, "network");
    assert.equal(offline.retry, true);
    const server = classifyConfirmError(new ApiError(503, "unavailable"));
    assert.equal(server.retry, true);
    assert.equal(classifyConfirmError(new ApiError(400, "Wrong label: expected unit HU-1")).retry, false);
    assert.equal(classifyConfirmError(new ApiError(409, "R01-1 is full")).retry, false);
  });
});
