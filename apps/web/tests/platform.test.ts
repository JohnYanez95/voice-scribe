/**
 * Platform abstraction tests — isDesktop detection and clipboard routing.
 *
 * Tests:
 *   - isDesktop() returns false when window.__TAURI__ is absent
 *   - isDesktop() returns true when window.__TAURI__ is present
 *   - writeClipboard() delegates to navigator.clipboard.writeText in browser
 *   - writeClipboard() POSTs to clipboard server in Tauri context
 *   - writeClipboard() throws on non-OK response from clipboard server
 *   - submitText() delegates to writeClipboard()
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { isDesktop, writeClipboard, submitText } from "../src/services/platform";

describe("isDesktop", () => {
  afterEach(() => {
    delete (window as any).__TAURI__;
  });

  it("returns false when window.__TAURI__ is undefined", () => {
    delete (window as any).__TAURI__;
    expect(isDesktop()).toBe(false);
  });

  it("returns true when window.__TAURI__ is defined", () => {
    (window as any).__TAURI__ = {};
    expect(isDesktop()).toBe(true);
  });

  it("returns true when window.__TAURI__ is a non-empty object", () => {
    (window as any).__TAURI__ = { event: {} };
    expect(isDesktop()).toBe(true);
  });
});

describe("writeClipboard — browser context", () => {
  beforeEach(() => {
    delete (window as any).__TAURI__;
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  it("calls navigator.clipboard.writeText with the provided text", async () => {
    await writeClipboard("hello");
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("hello");
  });

  it("propagates errors from navigator.clipboard.writeText", async () => {
    (navigator.clipboard.writeText as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("focus required")
    );
    await expect(writeClipboard("hello")).rejects.toThrow("focus required");
  });
});

describe("writeClipboard — Tauri context (HTTP clipboard server)", () => {
  beforeEach(() => {
    (window as any).__TAURI__ = {};
    global.fetch = vi.fn();
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  afterEach(() => {
    delete (window as any).__TAURI__;
    vi.restoreAllMocks();
  });

  it("POSTs to clipboard server with text body", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      status: 204,
    });
    await writeClipboard("from tauri");
    expect(global.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:8001/clipboard",
      { method: "POST", body: "from tauri" }
    );
    // navigator.clipboard should NOT have been called
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
  });

  it("throws on non-OK response", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: () => Promise.resolve("Clipboard init failed"),
    });
    await expect(writeClipboard("fail")).rejects.toThrow(
      "Clipboard write failed (500): Clipboard init failed"
    );
  });
});

describe("submitText", () => {
  beforeEach(() => {
    delete (window as any).__TAURI__;
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  it("delegates to writeClipboard (stub behavior until v3.2)", async () => {
    await submitText("submit test");
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("submit test");
  });
});
