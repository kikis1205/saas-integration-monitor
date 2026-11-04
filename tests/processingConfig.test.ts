import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROCESSING_STALE_MS,
  getProcessingConfig,
} from "../src/config/processing";

describe("getProcessingConfig", () => {
  it("defaults to 300000 when unset or blank", () => {
    expect(getProcessingConfig({}).staleMs).toBe(DEFAULT_PROCESSING_STALE_MS);
    expect(getProcessingConfig({ PROCESSING_STALE_MS: "" }).staleMs).toBe(
      DEFAULT_PROCESSING_STALE_MS,
    );
    expect(getProcessingConfig({ PROCESSING_STALE_MS: "   " }).staleMs).toBe(
      DEFAULT_PROCESSING_STALE_MS,
    );
  });

  it("parses a positive integer", () => {
    expect(getProcessingConfig({ PROCESSING_STALE_MS: "60000" }).staleMs).toBe(60_000);
  });

  it("rejects non-positive or non-integer values", () => {
    expect(() => getProcessingConfig({ PROCESSING_STALE_MS: "0" })).toThrow(
      /PROCESSING_STALE_MS must be a positive integer/,
    );
    expect(() => getProcessingConfig({ PROCESSING_STALE_MS: "-1" })).toThrow(
      /PROCESSING_STALE_MS must be a positive integer/,
    );
    expect(() => getProcessingConfig({ PROCESSING_STALE_MS: "1.5" })).toThrow(
      /PROCESSING_STALE_MS must be a positive integer/,
    );
    expect(() => getProcessingConfig({ PROCESSING_STALE_MS: "nope" })).toThrow(
      /PROCESSING_STALE_MS must be a positive integer/,
    );
  });
});
