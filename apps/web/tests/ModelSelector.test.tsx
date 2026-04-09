import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import { ModelSelector } from "../src/features/model-selector/ModelSelector";

vi.mock("../src/services/api", () => ({
  listModels: vi.fn(),
  swapModel: vi.fn(),
}));

import { listModels, swapModel } from "../src/services/api";

const mockListModels = listModels as ReturnType<typeof vi.fn>;
const mockSwapModel = swapModel as ReturnType<typeof vi.fn>;

const defaultProps = {
  backendReady: true,
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

describe("ModelSelector", () => {
  it("renders model list after loading", async () => {
    await act(async () => {
      render(<ModelSelector {...defaultProps} />);
    });

    await waitFor(() => {
      const options = screen.getAllByRole("option");
      expect(options.map((o) => o.textContent)).toContain("small");
      expect(options.map((o) => o.textContent)).toContain("large-v3");
    });
  });

  it("current model is selected", async () => {
    await act(async () => {
      render(<ModelSelector {...defaultProps} />);
    });

    await waitFor(() => {
      const select = screen.getByRole("combobox") as HTMLSelectElement;
      expect(select.value).toBe("large-v3");
    });
  });

  it("shows disabled state during swap", async () => {
    mockSwapModel.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                previous_model: "large-v3",
                current_model: "small",
                swap_duration: 2.0,
              }),
            100
          )
        )
    );

    await act(async () => {
      render(<ModelSelector {...defaultProps} />);
    });

    await waitFor(() => screen.getByRole("combobox"));

    const select = screen.getByRole("combobox") as HTMLSelectElement;
    await act(async () => {
      fireEvent.change(select, { target: { value: "small" } });
    });

    expect(screen.getByText("Swapping...")).toBeTruthy();
    expect(select.disabled).toBe(true);
  });

  it("updates selection on successful swap", async () => {
    mockSwapModel.mockResolvedValue({
      previous_model: "large-v3",
      current_model: "small",
      swap_duration: 2.0,
    });

    await act(async () => {
      render(<ModelSelector {...defaultProps} />);
    });

    await waitFor(() => screen.getByRole("combobox"));

    const select = screen.getByRole("combobox") as HTMLSelectElement;
    await act(async () => {
      fireEvent.change(select, { target: { value: "small" } });
    });

    await waitFor(() => {
      expect(select.value).toBe("small");
      expect(screen.getByText(/Swapped in/)).toBeTruthy();
    });
  });

  it("shows error on swap failure", async () => {
    mockSwapModel.mockRejectedValue(new Error("Load failed"));

    await act(async () => {
      render(<ModelSelector {...defaultProps} />);
    });

    await waitFor(() => screen.getByRole("combobox"));

    const select = screen.getByRole("combobox") as HTMLSelectElement;
    await act(async () => {
      fireEvent.change(select, { target: { value: "small" } });
    });

    await waitFor(() => {
      expect(screen.getByText("Load failed")).toBeTruthy();
    });
  });

  it("shows error state on fetch failure", async () => {
    mockListModels.mockRejectedValue(new Error("Network error"));

    await act(async () => {
      render(<ModelSelector {...defaultProps} />);
    });

    await waitFor(() => {
      const select = screen.getByRole("combobox") as HTMLSelectElement;
      expect(select.disabled).toBe(true);
    });
  });

  it("does not fetch when backendReady is false", async () => {
    await act(async () => {
      render(<ModelSelector {...defaultProps} backendReady={false} />);
    });

    expect(mockListModels).not.toHaveBeenCalled();
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    expect(select.disabled).toBe(true);
  });

  it("fetches when backendReady transitions to true", async () => {
    const { rerender } = render(
      <ModelSelector {...defaultProps} backendReady={false} />
    );

    expect(mockListModels).not.toHaveBeenCalled();

    await act(async () => {
      rerender(<ModelSelector {...defaultProps} backendReady={true} />);
    });

    await waitFor(() => {
      expect(mockListModels).toHaveBeenCalledOnce();
      const select = screen.getByRole("combobox") as HTMLSelectElement;
      expect(select.value).toBe("large-v3");
    });
  });
});
