import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import { Transcript } from "../src/features/transcript/Transcript";

// Mock platform module — writeClipboard is the clipboard routing surface
const mockWriteClipboard = vi.fn().mockResolvedValue(undefined);
vi.mock("../src/services/platform", () => ({
  writeClipboard: (...args: unknown[]) => mockWriteClipboard(...args),
  isDesktop: () => false,
}));

const defaultProps = {
  text: "",
  rawText: "",
  isLoading: false,
  onTextChange: () => {},
  showComparison: false,
  isRecordingActive: false,
};

describe("Transcript", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWriteClipboard.mockResolvedValue(undefined);
  });

  it("renders nothing when text is empty", () => {
    const { container } = render(<Transcript {...defaultProps} />);
    expect(container.querySelector(".transcript")).toBeNull();
  });

  it("shows loading state", () => {
    render(<Transcript {...defaultProps} isLoading={true} />);
    expect(screen.getByText("Transcribing...")).toBeTruthy();
  });

  it("renders transcript text in textarea", () => {
    render(<Transcript {...defaultProps} text="Hello world" />);
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(textarea.value).toBe("Hello world");
  });

  it("calls onTextChange when edited", () => {
    const onChange = vi.fn();
    render(<Transcript {...defaultProps} text="Hello" onTextChange={onChange} />);
    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "Hello world" } });
    expect(onChange).toHaveBeenCalledWith("Hello world");
  });

  it("copies text to clipboard via platform.writeClipboard on button click", async () => {
    render(<Transcript {...defaultProps} text="Copy me" />);
    const btn = screen.getByText("Copy to Clipboard");
    await act(async () => {
      fireEvent.click(btn);
    });

    await waitFor(() => {
      expect(mockWriteClipboard).toHaveBeenCalledWith("Copy me");
    });
  });

  it("shows 'Copied!' feedback after successful clipboard write", async () => {
    render(<Transcript {...defaultProps} text="Copy me" />);
    const btn = screen.getByText("Copy to Clipboard");
    await act(async () => {
      fireEvent.click(btn);
    });

    await waitFor(() => {
      expect(screen.getByText("Copied!")).toBeTruthy();
    });
  });

  it("handles clipboard write failure without crashing", async () => {
    mockWriteClipboard.mockRejectedValueOnce(new Error("Clipboard denied"));
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    render(<Transcript {...defaultProps} text="Copy me" />);
    const btn = screen.getByText("Copy to Clipboard");
    await act(async () => {
      fireEvent.click(btn);
    });

    await waitFor(() => {
      expect(consoleSpy).toHaveBeenCalledWith(
        "[Transcript] clipboard write failed:",
        expect.any(Error)
      );
    });

    // Button should NOT show "Copied!" on failure
    expect(screen.getByText("Copy to Clipboard")).toBeTruthy();
    consoleSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Auto-scroll pin logic
//
// jsdom textareas have scrollHeight=0, clientHeight=0, scrollTop=0 by default.
// We mock the layout properties via Object.defineProperty to simulate overflow.
// ---------------------------------------------------------------------------

/** Set up mock scroll dimensions on a textarea element. */
function mockScrollDimensions(
  el: HTMLTextAreaElement,
  opts: { scrollHeight: number; clientHeight: number; scrollTop?: number }
) {
  Object.defineProperty(el, "scrollHeight", {
    configurable: true,
    get: () => opts.scrollHeight,
  });
  Object.defineProperty(el, "clientHeight", {
    configurable: true,
    get: () => opts.clientHeight,
  });
  // scrollTop needs get + set so we can both read and assign it.
  let _scrollTop = opts.scrollTop ?? 0;
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => _scrollTop,
    set: (v: number) => { _scrollTop = v; },
  });
}

describe("Transcript — auto-scroll", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("scrolls to bottom when text changes (pin is on by default)", () => {
    const { rerender } = render(
      <Transcript {...defaultProps} text="first segment" isRecordingActive={true} />
    );
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    mockScrollDimensions(textarea, { scrollHeight: 500, clientHeight: 100 });

    // New segment arrives — text prop changes
    rerender(
      <Transcript {...defaultProps} text="first segment second segment" isRecordingActive={true} />
    );

    expect(textarea.scrollTop).toBe(500);
  });

  it("stops auto-scrolling after user scrolls up", () => {
    const { rerender } = render(
      <Transcript {...defaultProps} text="first" isRecordingActive={true} />
    );
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    mockScrollDimensions(textarea, {
      scrollHeight: 500,
      clientHeight: 100,
      scrollTop: 50, // user scrolled to near the top
    });

    // User scrolls up — fires onScroll, not at bottom → unpin
    fireEvent.scroll(textarea);

    // New segment arrives
    rerender(
      <Transcript {...defaultProps} text="first second" isRecordingActive={true} />
    );

    // scrollTop should stay where the user put it, not jump to 500
    expect(textarea.scrollTop).toBe(50);
  });

  it("re-engages auto-scroll when user scrolls back to bottom", () => {
    const { rerender } = render(
      <Transcript {...defaultProps} text="first" isRecordingActive={true} />
    );
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;

    // Step 1: user scrolls up → unpin
    mockScrollDimensions(textarea, {
      scrollHeight: 500,
      clientHeight: 100,
      scrollTop: 50,
    });
    fireEvent.scroll(textarea);

    // Step 2: user scrolls back to bottom → re-pin
    mockScrollDimensions(textarea, {
      scrollHeight: 500,
      clientHeight: 100,
      scrollTop: 400, // 400 + 100 = 500 = scrollHeight → at bottom
    });
    fireEvent.scroll(textarea);

    // Step 3: new segment arrives → should auto-scroll
    rerender(
      <Transcript {...defaultProps} text="first second" isRecordingActive={true} />
    );

    expect(textarea.scrollTop).toBe(500);
  });

  it("re-engages pin when isRecordingActive transitions to true", () => {
    const { rerender } = render(
      <Transcript {...defaultProps} text="first" isRecordingActive={true} />
    );
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;

    // User scrolls up → unpin
    mockScrollDimensions(textarea, {
      scrollHeight: 500,
      clientHeight: 100,
      scrollTop: 50,
    });
    fireEvent.scroll(textarea);

    // Session ends
    rerender(
      <Transcript {...defaultProps} text="first" isRecordingActive={false} />
    );

    // New session starts → pin re-engages
    rerender(
      <Transcript {...defaultProps} text="first" isRecordingActive={true} />
    );

    // New segment arrives → should auto-scroll
    rerender(
      <Transcript {...defaultProps} text="first second" isRecordingActive={true} />
    );

    expect(textarea.scrollTop).toBe(500);
  });

  it("user edit releases pin — new segment does not jump scroll", () => {
    const onTextChange = vi.fn();
    const { rerender } = render(
      <Transcript
        {...defaultProps}
        text="first segment"
        onTextChange={onTextChange}
        isRecordingActive={true}
      />
    );
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    mockScrollDimensions(textarea, {
      scrollHeight: 500,
      clientHeight: 100,
      scrollTop: 200, // user is mid-document
    });

    // Step 1: user edits (onChange fires, isPinned set to false)
    fireEvent.change(textarea, { target: { value: "first segment edited" } });
    expect(onTextChange).toHaveBeenCalledWith("first segment edited");

    // Step 2: new VAD segment arrives via prop update
    rerender(
      <Transcript
        {...defaultProps}
        text="first segment edited new segment"
        onTextChange={onTextChange}
        isRecordingActive={true}
      />
    );

    // scrollTop should stay where the user was editing, not jump
    expect(textarea.scrollTop).toBe(200);
  });
});
