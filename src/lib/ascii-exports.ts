// Export helpers. Kept pure so they can be tested and reused from anywhere.

export function toPlainText(chars: string[]): string {
  return chars.join("\n");
}

export function toMarkdown(chars: string[]): string {
  return "```\n" + chars.join("\n") + "\n```\n";
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Run-length merge adjacent same-color characters into single spans so
// coloured HTML output doesn't explode into megabytes for large grids.
export function toColorHtml(chars: string[], colors: string[][] | null): string {
  const style =
    'style="font-family:JetBrains Mono,ui-monospace,monospace;' +
    "line-height:1;white-space:pre;background:#111;color:#eee;" +
    'padding:12px;border-radius:6px;font-size:12px;overflow:auto;"';
  if (!colors) {
    return `<pre ${style}>${escapeHtml(chars.join("\n"))}</pre>`;
  }
  const out: string[] = [`<pre ${style}>`];
  for (let y = 0; y < chars.length; y++) {
    const line = chars[y];
    const rowColors = colors[y];
    let runColor = "";
    let runText = "";
    for (let x = 0; x < line.length; x++) {
      const c = rowColors[x];
      if (c !== runColor) {
        if (runText) out.push(`<span style="color:${runColor}">${escapeHtml(runText)}</span>`);
        runColor = c;
        runText = line[x];
      } else {
        runText += line[x];
      }
    }
    if (runText) out.push(`<span style="color:${runColor}">${escapeHtml(runText)}</span>`);
    out.push("\n");
  }
  out.push("</pre>");
  return out.join("");
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 500);
}

// Render ASCII back into a PNG at 2x for crisp copy-paste into decks.
export function renderAsciiToPng(
  chars: string[],
  colors: string[][] | null,
  opts: { fontSize: number; background: string; foreground: string },
): Promise<Blob> {
  const scale = 2;
  const fs = opts.fontSize * scale;
  // JetBrains Mono cell metrics: width ≈ 0.6em
  const cellW = fs * 0.6;
  const cellH = fs; // line-height 1
  const rows = chars.length;
  const cols = chars.reduce((m, l) => Math.max(m, l.length), 0);
  const pad = 16 * scale;
  const w = Math.ceil(cols * cellW) + pad * 2;
  const h = Math.ceil(rows * cellH) + pad * 2;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = opts.background;
  ctx.fillRect(0, 0, w, h);
  ctx.font = `${fs}px "JetBrains Mono", ui-monospace, monospace`;
  ctx.textBaseline = "top";
  for (let y = 0; y < rows; y++) {
    const line = chars[y];
    const rowColors = colors?.[y];
    for (let x = 0; x < line.length; x++) {
      ctx.fillStyle = rowColors ? rowColors[x] : opts.foreground;
      ctx.fillText(line[x], pad + x * cellW, pad + y * cellH);
    }
  }
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b!), "image/png"));
}