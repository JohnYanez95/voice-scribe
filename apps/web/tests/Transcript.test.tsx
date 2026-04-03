import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Transcript } from "../src/features/transcript/Transcript";

describe("Transcript", () => {
  it("renders nothing when text is empty", () => {
    const { container } = render(
      <Transcript text="" isLoading={false} rawText="" onTextChange={() => {}} />
    );
    expect(container.querySelector(".transcript")).toBeNull();
  });

  it("shows loading state", () => {
    render(<Transcript text="" isLoading={true} rawText="" onTextChange={() => {}} />);
    expect(screen.getByText("Transcribing...")).toBeTruthy();
  });

  it("renders transcript text in textarea", () => {
    render(
      <Transcript text="Hello world" isLoading={false} rawText="" onTextChange={() => {}} />
    );
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(textarea.value).toBe("Hello world");
  });

  it("calls onTextChange when edited", () => {
    const onChange = vi.fn();
    render(
      <Transcript text="Hello" isLoading={false} rawText="" onTextChange={onChange} />
    );
    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "Hello world" } });
    expect(onChange).toHaveBeenCalledWith("Hello world");
  });

  it("copies text to clipboard on button click", async () => {
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });

    render(
      <Transcript text="Copy me" isLoading={false} rawText="" onTextChange={() => {}} />
    );
    const btn = screen.getByText("Copy to Clipboard");
    fireEvent.click(btn);

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("Copy me");
  });
});
