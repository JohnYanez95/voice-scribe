import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import { Settings } from "../src/features/settings/Settings";

// Mock the api module
vi.mock("../src/services/api", () => ({
  listModels: vi.fn(),
  swapModel: vi.fn(),
}));

import { listModels, swapModel } from "../src/services/api";

const mockListModels = listModels as ReturnType<typeof vi.fn>;
const mockSwapModel = swapModel as ReturnType<typeof vi.fn>;

const defaultProps = {
  isOpen: true,
  onClose: vi.fn(),
  onSwapStateChange: vi.fn(),
  showRawComparison: false,
  onShowRawComparisonChange: vi.fn(),
  recordingMode: "push-to-talk" as const,
  onRecordingModeChange: vi.fn(),
  audioMuted: false,
  onAudioMutedChange: vi.fn(),
  isActive: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockListModels.mockResolvedValue({
    models: [
      { name: "small", is_current: false },
      { name: "large-v3", is_current: true },
    ],
    current_model: "large-v3",
  });
});

describe("Settings", () => {
  it("renders model list after loading", async () => {
    await act(async () => {
      render(<Settings {...defaultProps} />);
    });

    await waitFor(() => {
      expect(screen.getByText("small")).toBeTruthy();
      expect(screen.getByText("large-v3")).toBeTruthy();
    });
  });

  it("current model is selected", async () => {
    await act(async () => {
      render(<Settings {...defaultProps} />);
    });

    await waitFor(() => {
      const radios = screen.getAllByRole("radio") as HTMLInputElement[];
      const largeRadio = radios.find((r) => r.value === "large-v3");
      expect(largeRadio?.checked).toBe(true);
    });
  });

  it("shows loading state during swap", async () => {
    mockSwapModel.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({
        previous_model: "large-v3",
        current_model: "small",
        swap_duration: 2.0,
      }), 100))
    );

    await act(async () => {
      render(<Settings {...defaultProps} />);
    });

    await waitFor(() => screen.getByText("small"));

    const smallRadio = screen.getAllByRole("radio").find(
      (r) => (r as HTMLInputElement).value === "small"
    ) as HTMLInputElement;

    await act(async () => {
      fireEvent.click(smallRadio);
    });

    expect(screen.getByText("Swapping model...")).toBeTruthy();
  });

  it("updates selection on successful swap", async () => {
    mockSwapModel.mockResolvedValue({
      previous_model: "large-v3",
      current_model: "small",
      swap_duration: 2.0,
    });

    await act(async () => {
      render(<Settings {...defaultProps} />);
    });

    await waitFor(() => screen.getByText("small"));

    const smallRadio = screen.getAllByRole("radio").find(
      (r) => (r as HTMLInputElement).value === "small"
    ) as HTMLInputElement;

    await act(async () => {
      fireEvent.click(smallRadio);
    });

    await waitFor(() => {
      expect(smallRadio.checked).toBe(true);
      expect(screen.getByText(/Swapped in/)).toBeTruthy();
    });
  });

  it("shows error on swap failure", async () => {
    mockSwapModel.mockRejectedValue(new Error("Load failed"));

    await act(async () => {
      render(<Settings {...defaultProps} />);
    });

    await waitFor(() => screen.getByText("small"));

    const smallRadio = screen.getAllByRole("radio").find(
      (r) => (r as HTMLInputElement).value === "small"
    ) as HTMLInputElement;

    await act(async () => {
      fireEvent.click(smallRadio);
    });

    await waitFor(() => {
      expect(screen.getByText("Load failed")).toBeTruthy();
    });
  });

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

  it("shows error with retry on fetch failure", async () => {
    mockListModels.mockRejectedValue(new Error("Network error"));

    await act(async () => {
      render(<Settings {...defaultProps} />);
    });

    await waitFor(() => {
      expect(screen.getByText("Failed to load models")).toBeTruthy();
      expect(screen.getByText("Retry")).toBeTruthy();
    });
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
});
