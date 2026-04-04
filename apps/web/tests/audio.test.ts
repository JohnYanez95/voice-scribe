import { describe, it, expect } from "vitest";
import { encodeWav, encodeWavBuffer } from "../src/utils/audio";

describe("encodeWavBuffer", () => {
  const sampleRate = 16000;
  const samples = new Float32Array(100).fill(0.5);

  it("first 4 bytes are RIFF magic", () => {
    const buf = encodeWavBuffer(samples, sampleRate);
    const view = new DataView(buf);
    const riff = String.fromCharCode(
      view.getUint8(0),
      view.getUint8(1),
      view.getUint8(2),
      view.getUint8(3)
    );
    expect(riff).toBe("RIFF");
  });

  it("bytes 8–11 are WAVE", () => {
    const buf = encodeWavBuffer(samples, sampleRate);
    const view = new DataView(buf);
    const wave = String.fromCharCode(
      view.getUint8(8),
      view.getUint8(9),
      view.getUint8(10),
      view.getUint8(11)
    );
    expect(wave).toBe("WAVE");
  });

  it("data chunk size matches sample count × 2 (16-bit mono)", () => {
    const buf = encodeWavBuffer(samples, sampleRate);
    const view = new DataView(buf);
    // data chunk size is at byte 40 (little-endian uint32)
    const dataSize = view.getUint32(40, true);
    expect(dataSize).toBe(samples.length * 2);
  });

  it("total buffer size is 44-byte header plus data", () => {
    const buf = encodeWavBuffer(samples, sampleRate);
    expect(buf.byteLength).toBe(44 + samples.length * 2);
  });

  it("clamps samples outside [-1, 1] without throwing", () => {
    const clipped = new Float32Array([2.0, -2.0, 0.0]);
    expect(() => encodeWavBuffer(clipped, sampleRate)).not.toThrow();
  });
});

describe("encodeWav", () => {
  const sampleRate = 16000;
  const samples = new Float32Array(100).fill(0.5);

  it("returns a Blob with audio/wav type", () => {
    const blob = encodeWav(samples, sampleRate);
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe("audio/wav");
  });

  it("blob size matches 44-byte header plus sample data", () => {
    const blob = encodeWav(samples, sampleRate);
    expect(blob.size).toBe(44 + samples.length * 2);
  });
});
