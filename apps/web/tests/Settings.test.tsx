import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { Settings } from "../src/features/settings/Settings";

const defaultProps = {
  isOpen: true,
  onClose: vi.fn(),
  showRawComparison: false,
  onShowRawComparisonChange: vi.fn(),
  recordingMode: "push-to-talk" as const,
  onRecordingModeChange: vi.fn(),
  audioMuted: false,
  onAudioMutedChange: vi.fn(),
  maxDuration: 60,
  onMaxDurationChange: vi.fn(),
  isActive: false,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Settings", () => {
  it("calls onClose when close button clicked", async () => {
    await act(async () => {
      render(<Settings {...defaultProps} />);
    });

    const closeBtn = screen.getByLabelText("Close");
    fireEvent.click(closeBtn);
    expect(defaultProps.onClose).toHaveBeenCalled();
  });

  it("closes on Escape key", async () => {
    await act(async () => {
      render(<Settings {...defaultProps} />);
    });

    fireEvent.keyDown(document, { key: "Escape" });
    expect(defaultProps.onClose).toHaveBeenCalled();
  });

  it("renders nothing when closed", () => {
    const { container } = render(<Settings {...defaultProps} isOpen={false} />);
    expect(container.querySelector(".settings-panel")).toBeNull();
  });

  it("comparison toggle renders unchecked by default", async () => {
    await act(async () => {
      render(<Settings {...defaultProps} showRawComparison={false} />);
    });

    const checkbox = screen.getByRole("checkbox", { name: /raw.*cleaned/i }) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
  });

  it("checking comparison toggle calls onShowRawComparisonChange(true)", async () => {
    const onShowRawComparisonChange = vi.fn();
    await act(async () => {
      render(
        <Settings
          {...defaultProps}
          showRawComparison={false}
          onShowRawComparisonChange={onShowRawComparisonChange}
        />
      );
    });

    const checkbox = screen.getByRole("checkbox", { name: /raw.*cleaned/i });
    fireEvent.click(checkbox);
    expect(onShowRawComparisonChange).toHaveBeenCalledWith(true);
  });

  it("unchecking comparison toggle calls onShowRawComparisonChange(false)", async () => {
    const onShowRawComparisonChange = vi.fn();
    await act(async () => {
      render(
        <Settings
          {...defaultProps}
          showRawComparison={true}
          onShowRawComparisonChange={onShowRawComparisonChange}
        />
      );
    });

    const checkbox = screen.getByRole("checkbox", { name: /raw.*cleaned/i });
    fireEvent.click(checkbox);
    expect(onShowRawComparisonChange).toHaveBeenCalledWith(false);
  });

  it("recording mode section renders with push-to-talk selected by default", async () => {
    await act(async () => {
      render(<Settings {...defaultProps} recordingMode="push-to-talk" />);
    });

    const pttRadio = screen.getByRole("radio", { name: "Push-to-talk" }) as HTMLInputElement;
    const contRadio = screen.getByRole("radio", { name: "Continuous" }) as HTMLInputElement;
    expect(pttRadio.checked).toBe(true);
    expect(contRadio.checked).toBe(false);
  });

  it("clicking continuous fires onRecordingModeChange('continuous')", async () => {
    const onRecordingModeChange = vi.fn();
    await act(async () => {
      render(
        <Settings
          {...defaultProps}
          recordingMode="push-to-talk"
          onRecordingModeChange={onRecordingModeChange}
        />
      );
    });

    const contRadio = screen.getByRole("radio", { name: "Continuous" });
    fireEvent.click(contRadio);
    expect(onRecordingModeChange).toHaveBeenCalledWith("continuous");
  });

  it("mode radios are disabled when isActive is true", async () => {
    await act(async () => {
      render(<Settings {...defaultProps} isActive={true} />);
    });

    const pttRadio = screen.getByRole("radio", { name: "Push-to-talk" }) as HTMLInputElement;
    const contRadio = screen.getByRole("radio", { name: "Continuous" }) as HTMLInputElement;
    expect(pttRadio.disabled).toBe(true);
    expect(contRadio.disabled).toBe(true);
  });

  it("mute toggle renders unchecked by default", async () => {
    await act(async () => {
      render(<Settings {...defaultProps} audioMuted={false} />);
    });

    const checkbox = screen.getByRole("checkbox", { name: /mute/i }) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
  });

  it("checking mute toggle calls onAudioMutedChange(true)", async () => {
    const onAudioMutedChange = vi.fn();
    await act(async () => {
      render(
        <Settings
          {...defaultProps}
          audioMuted={false}
          onAudioMutedChange={onAudioMutedChange}
        />
      );
    });

    const checkbox = screen.getByRole("checkbox", { name: /mute/i });
    fireEvent.click(checkbox);
    expect(onAudioMutedChange).toHaveBeenCalledWith(true);
  });

  it("unchecking mute toggle calls onAudioMutedChange(false)", async () => {
    const onAudioMutedChange = vi.fn();
    await act(async () => {
      render(
        <Settings
          {...defaultProps}
          audioMuted={true}
          onAudioMutedChange={onAudioMutedChange}
        />
      );
    });

    const checkbox = screen.getByRole("checkbox", { name: /mute/i });
    fireEvent.click(checkbox);
    expect(onAudioMutedChange).toHaveBeenCalledWith(false);
  });

  it("renders max duration input with current value", async () => {
    await act(async () => {
      render(<Settings {...defaultProps} maxDuration={90} />);
    });

    const input = screen.getByLabelText(/max recording duration/i) as HTMLInputElement;
    expect(input.value).toBe("90");
    expect(input.type).toBe("number");
  });

  it("changing duration input calls onMaxDurationChange", async () => {
    const onMaxDurationChange = vi.fn();
    await act(async () => {
      render(
        <Settings
          {...defaultProps}
          maxDuration={60}
          onMaxDurationChange={onMaxDurationChange}
        />
      );
    });

    const input = screen.getByLabelText(/max recording duration/i);
    fireEvent.change(input, { target: { value: "45" } });
    expect(onMaxDurationChange).toHaveBeenCalledWith(45);
  });

  it("duration input is disabled when isActive is true", async () => {
    await act(async () => {
      render(<Settings {...defaultProps} isActive={true} />);
    });

    const input = screen.getByLabelText(/max recording duration/i) as HTMLInputElement;
    expect(input.disabled).toBe(true);
  });
});
