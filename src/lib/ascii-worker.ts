/// <reference lib="webworker" />

// ASCII conversion worker. Never touches the DOM; all heavy lifting lives here.

export interface AsciiOptions {
  targetCols: number;
  charAspect: number; // height / width of a character cell (~2.0)
  ramp: string; // dark -> light
  gamma: number; // 0.3 - 3
  dither: boolean;
  color: boolean;
  edges: boolean;
  edgeStrength: number; // 0 - 1
  alphaThreshold: number; // 0-255
}

export interface AsciiRequest {
  id: number;
  type: "render";
  image: ImageData;
  options: AsciiOptions;
}

export interface AsciiResult {
  id: number;
  type: "result";
  chars: string[]; // one string per row
  colors: string[][] | null; // per-cell "#rrggbb" if color mode
  cols: number;
  rows: number;
  ms: number;
}

const EDGE_CHARS = ["\u2014", "/", "|", "\\"]; // 0°, 45°, 90°, 135°

function downscale(src: ImageData, cols: number, rows: number): ImageData {
  const canvas = new OffscreenCanvas(cols, rows);
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const srcCanvas = new OffscreenCanvas(src.width, src.height);
  srcCanvas.getContext("2d")!.putImageData(src, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(srcCanvas, 0, 0, cols, rows);
  return ctx.getImageData(0, 0, cols, rows);
}

function toGrayscale(img: ImageData, gamma: number): { gray: Float32Array; alpha: Uint8ClampedArray } {
  const { data, width, height } = img;
  const gray = new Float32Array(width * height);
  const alpha = new Uint8ClampedArray(width * height);
  const invGamma = 1 / gamma;
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const r = data[i] / 255;
    const g = data[i + 1] / 255;
    const b = data[i + 2] / 255;
    // Rec. 709 luminance
    let l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    l = Math.pow(Math.max(0, Math.min(1, l)), invGamma);
    gray[p] = l;
    alpha[p] = data[i + 3];
  }
  return { gray, alpha };
}

function floydSteinberg(gray: Float32Array, w: number, h: number, levels: number) {
  const step = 1 / (levels - 1);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const old = gray[i];
      const quant = Math.round(old / step) * step;
      const err = old - quant;
      gray[i] = quant;
      if (x + 1 < w) gray[i + 1] += err * (7 / 16);
      if (y + 1 < h) {
        if (x > 0) gray[i + w - 1] += err * (3 / 16);
        gray[i + w] += err * (5 / 16);
        if (x + 1 < w) gray[i + w + 1] += err * (1 / 16);
      }
    }
  }
}

function sobel(gray: Float32Array, w: number, h: number) {
  const mag = new Float32Array(w * h);
  const dir = new Uint8Array(w * h); // 0..3 index into EDGE_CHARS
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx =
        -gray[i - w - 1] - 2 * gray[i - 1] - gray[i + w - 1] +
        gray[i - w + 1] + 2 * gray[i + 1] + gray[i + w + 1];
      const gy =
        -gray[i - w - 1] - 2 * gray[i - w] - gray[i - w + 1] +
        gray[i + w - 1] + 2 * gray[i + w] + gray[i + w + 1];
      const m = Math.sqrt(gx * gx + gy * gy);
      mag[i] = m;
      // angle in [0, 180)
      let a = (Math.atan2(gy, gx) * 180) / Math.PI;
      if (a < 0) a += 180;
      // 0 = —, 1 = /, 2 = |, 3 = \
      let idx = 0;
      if (a < 22.5 || a >= 157.5) idx = 0;
      else if (a < 67.5) idx = 1;
      else if (a < 112.5) idx = 2;
      else idx = 3;
      dir[i] = idx;
    }
  }
  return { mag, dir };
}

function toHex(r: number, g: number, b: number): string {
  const h = (v: number) => v.toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

function render(req: AsciiRequest): AsciiResult {
  const t0 = performance.now();
  const { image, options } = req;
  const cols = Math.max(4, Math.floor(options.targetCols));
  const rows = Math.max(
    2,
    Math.floor((image.height / image.width) * cols / options.charAspect),
  );

  const small = downscale(image, cols, rows);
  const { gray, alpha } = toGrayscale(small, options.gamma);

  const rampLen = options.ramp.length;
  if (options.dither && rampLen >= 2) {
    floydSteinberg(gray, cols, rows, rampLen);
  }

  let edgeData: { mag: Float32Array; dir: Uint8Array } | null = null;
  let maxMag = 0;
  if (options.edges) {
    edgeData = sobel(gray, cols, rows);
    for (let i = 0; i < edgeData.mag.length; i++)
      if (edgeData.mag[i] > maxMag) maxMag = edgeData.mag[i];
  }

  const chars: string[] = new Array(rows);
  const colors: string[][] | null = options.color ? new Array(rows) : null;
  const src = small.data;

  for (let y = 0; y < rows; y++) {
    let line = "";
    const rowColors: string[] | null = colors ? new Array(cols) : null;
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x;
      if (alpha[i] < options.alphaThreshold) {
        line += " ";
        if (rowColors) rowColors[x] = "#000000";
        continue;
      }
      const g = Math.max(0, Math.min(1, gray[i]));
      let idx = Math.round(g * (rampLen - 1));
      let ch = options.ramp[idx] ?? " ";

      if (edgeData && maxMag > 0) {
        const m = edgeData.mag[i] / maxMag;
        if (m > 1 - options.edgeStrength * 0.9) {
          ch = EDGE_CHARS[edgeData.dir[i]];
        }
      }

      line += ch;
      if (rowColors) {
        const p = i * 4;
        rowColors[x] = toHex(src[p], src[p + 1], src[p + 2]);
      }
    }
    chars[y] = line;
    if (colors && rowColors) colors[y] = rowColors;
  }

  return {
    id: req.id,
    type: "result",
    chars,
    colors,
    cols,
    rows,
    ms: performance.now() - t0,
  };
}

self.onmessage = (e: MessageEvent<AsciiRequest>) => {
  if (e.data?.type === "render") {
    const res = render(e.data);
    (self as unknown as Worker).postMessage(res);
  }
};