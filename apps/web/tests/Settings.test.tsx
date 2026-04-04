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
});
