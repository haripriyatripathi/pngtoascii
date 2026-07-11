import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
} from "react";
import type { AsciiOptions, AsciiRequest, AsciiResult } from "@/lib/ascii-worker";
import {
  downloadBlob,
  renderAsciiToPng,
  toColorHtml,
  toMarkdown,
  toPlainText,
} from "@/lib/ascii-exports";

const RAMPS: Record<string, string> = {
  detailed: "@%#*+=-:. ",
  blocks: "\u2588\u2593\u2592\u2591 ",
  binary: "10 ",
};

const MAX_SOURCE_DIM = 1600; // pre-downscale cap so 40MP screenshots don't nuke memory

interface Options {
  targetCols: number;
  gamma: number;
  rampKey: "detailed" | "blocks" | "binary" | "custom";
  customRamp: string;
  invert: boolean;
  dither: boolean;
  color: boolean;
  edges: boolean;
  edgeStrength: number;
  fontSize: number;
}

const DEFAULTS: Options = {
  targetCols: 160,
  gamma: 1.0,
  rampKey: "detailed",
  customRamp: "@%#*+=-:. ",
  invert: false,
  dither: true,
  color: false,
  edges: false,
  edgeStrength: 0.5,
  fontSize: 8,
};

function resolveRamp(o: Options): string {
  const base = o.rampKey === "custom" ? o.customRamp || " " : RAMPS[o.rampKey];
  // Store the ramp reversed when invert is on rather than inverting pixel data.
  return o.invert ? base.split("").reverse().join("") : base;
}

async function decodeAndCache(file: Blob): Promise<ImageData> {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SOURCE_DIM / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  return ctx.getImageData(0, 0, w, h);
}

const PLACEHOLDER_FRAMES = [
  ["   .:--==++**##%%@@   ", "  drop  a  PNG  here  ", "  paste .  click .  drag  "],
  ["   .:-=+*#%@#*+=-:.   ", "  drop  a  PNG  here  ", "  paste .  click .  drag  "],
  ["   @%#*+=-:..:-=+*#%   ", "  drop  a  PNG  here  ", "  paste .  click .  drag  "],
  ["   %#*+=-:.  .:-=+*#   ", "  drop  a  PNG  here  ", "  paste .  click .  drag  "],
];

function useAnimatedPlaceholder() {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setFrame((f) => (f + 1) % PLACEHOLDER_FRAMES.length), 260);
    return () => window.clearInterval(id);
  }, []);
  return PLACEHOLDER_FRAMES[frame];
}

export function AsciifyApp() {
  const [opts, setOpts] = useState<Options>(DEFAULTS);
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [sourceMeta, setSourceMeta] = useState<{ w: number; h: number; name: string } | null>(null);
  const [result, setResult] = useState<AsciiResult | null>(null);
  const [status, setStatus] = useState<string>("ready");
  const [split, setSplit] = useState<number>(0.5);
  const [dragging, setDragging] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const sourceDataRef = useRef<ImageData | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const reqIdRef = useRef(0);
  const lastAcceptedRef = useRef(0);
  const debounceRef = useRef<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const dividerRef = useRef<HTMLDivElement | null>(null);
  const splitContainerRef = useRef<HTMLDivElement | null>(null);

  // --- worker lifecycle ---
  useEffect(() => {
    const w = new Worker(new URL("../../lib/ascii-worker.ts", import.meta.url), {
      type: "module",
    });
    workerRef.current = w;
    w.onmessage = (e: MessageEvent<AsciiResult>) => {
      const r = e.data;
      if (r.id < lastAcceptedRef.current) return; // stale
      lastAcceptedRef.current = r.id;
      setResult(r);
      setStatus("ok");
    };
    return () => {
      w.terminate();
      workerRef.current = null;
    };
  }, []);

  // --- render dispatch (debounced) ---
  const dispatchRender = useCallback((next: Options) => {
    const img = sourceDataRef.current;
    const w = workerRef.current;
    if (!img || !w) return;
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      const id = ++reqIdRef.current;
      const asciiOptions: AsciiOptions = {
        targetCols: next.targetCols,
        charAspect: 2.0,
        ramp: resolveRamp(next),
        gamma: next.gamma,
        dither: next.dither,
        color: next.color,
        edges: next.edges,
        edgeStrength: next.edgeStrength,
        alphaThreshold: 10,
      };
      const msg: AsciiRequest = { id, type: "render", image: img, options: asciiOptions };
      w.postMessage(msg);
      setStatus("rendering\u2026");
    }, 80);
  }, []);

  useEffect(() => {
    if (sourceDataRef.current) dispatchRender(opts);
  }, [opts, dispatchRender]);

  // --- file ingestion ---
  const acceptFile = useCallback(
    async (file: File | Blob, name = "image.png") => {
      setStatus("decoding\u2026");
      try {
        const data = await decodeAndCache(file);
        sourceDataRef.current = data;
        if (sourceUrl) URL.revokeObjectURL(sourceUrl);
        const url = URL.createObjectURL(file);
        setSourceUrl(url);
        setSourceMeta({ w: data.width, h: data.height, name });
        dispatchRender(opts);
      } catch (err) {
        console.error(err);
        setStatus("decode failed");
      }
    },
    [dispatchRender, opts, sourceUrl],
  );

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file && file.type.startsWith("image/")) acceptFile(file, file.name);
  };

  const onFileInput = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) acceptFile(f, f.name);
  };

  // --- clipboard paste ---
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (it.type.startsWith("image/")) {
          const f = it.getAsFile();
          if (f) {
            acceptFile(f, f.name || "pasted.png");
            e.preventDefault();
            return;
          }
        }
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [acceptFile]);

  // --- divider drag ---
  useEffect(() => {
    const div = dividerRef.current;
    const container = splitContainerRef.current;
    if (!div || !container) return;
    let active = false;
    const onDown = (e: PointerEvent) => {
      active = true;
      div.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      if (!active) return;
      const rect = container.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width;
      setSplit(Math.max(0.15, Math.min(0.85, x)));
    };
    const onUp = (e: PointerEvent) => {
      active = false;
      try { div.releasePointerCapture(e.pointerId); } catch { /* noop */ }
    };
    div.addEventListener("pointerdown", onDown);
    div.addEventListener("pointermove", onMove);
    div.addEventListener("pointerup", onUp);
    return () => {
      div.removeEventListener("pointerdown", onDown);
      div.removeEventListener("pointermove", onMove);
      div.removeEventListener("pointerup", onUp);
    };
  }, []);

  // --- exports ---
  const flashCopied = (label: string) => {
    setCopied(label);
    window.setTimeout(() => setCopied(null), 1200);
  };
  const copy = async (text: string, label: string) => {
    await navigator.clipboard.writeText(text);
    flashCopied(label);
  };
  const copyRaw = () => result && copy(toPlainText(result.chars), "raw");
  const copyMd = () => result && copy(toMarkdown(result.chars), "markdown");
  const copyHtml = () => result && copy(toColorHtml(result.chars, result.colors), "html");
  const downloadTxt = () => {
    if (!result) return;
    downloadBlob(new Blob([toPlainText(result.chars)], { type: "text/plain" }), "ascii.txt");
  };
  const downloadPng = async () => {
    if (!result) return;
    const blob = await renderAsciiToPng(result.chars, result.colors, {
      fontSize: opts.fontSize,
      background: "#0d1117",
      foreground: "#7ee787",
    });
    downloadBlob(blob, "ascii.png");
  };

  const colouredHtml = useMemo(() => {
    if (!result || !result.colors) return null;
    return toColorHtml(result.chars, result.colors);
  }, [result]);

  const placeholder = useAnimatedPlaceholder();
  const hasImage = !!sourceMeta;

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <Header hasImage={hasImage} onOpen={() => fileInputRef.current?.click()} />

      <div className="flex min-h-0 flex-1">
        {/* Left control panel */}
        <aside className="w-[300px] shrink-0 overflow-y-auto border-r border-border bg-sidebar p-4 text-sm">
          <Controls opts={opts} setOpts={setOpts} disabled={!hasImage} />
          <div className="mt-6 border-t border-border pt-4">
            <h3 className="mb-2 text-xs uppercase tracking-widest text-muted-foreground">export</h3>
            <div className="grid grid-cols-2 gap-2">
              <ExportBtn onClick={copyRaw} disabled={!result}>copy text</ExportBtn>
              <ExportBtn onClick={copyMd} disabled={!result}>copy markdown</ExportBtn>
              <ExportBtn onClick={copyHtml} disabled={!result}>copy html</ExportBtn>
              <ExportBtn onClick={downloadTxt} disabled={!result}>.txt</ExportBtn>
              <ExportBtn onClick={downloadPng} disabled={!result} className="col-span-2">
                download .png (2×)
              </ExportBtn>
            </div>
            {copied && (
              <p className="mt-2 text-xs text-primary">copied {copied} to clipboard</p>
            )}
            <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
              markdown export strips colour — use html or png if you need it.
            </p>
          </div>
        </aside>

        {/* Right split view */}
        <main className="relative flex min-w-0 flex-1 flex-col">
          {!hasImage ? (
            <DropZone
              placeholder={placeholder}
              dragging={dragging}
              onDrop={onDrop}
              onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onClick={() => fileInputRef.current?.click()}
            />
          ) : (
            <div ref={splitContainerRef} className="relative flex min-h-0 flex-1">
              <section
                className="relative min-w-0 overflow-auto bg-black/40"
                style={{ width: `${split * 100}%` }}
              >
                <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-background/80 px-3 py-1.5 text-[11px] uppercase tracking-widest text-muted-foreground backdrop-blur">
                  source · {sourceMeta.w}×{sourceMeta.h} · {sourceMeta.name}
                </div>
                {sourceUrl && (
                  <img src={sourceUrl} alt="source" className="mx-auto block max-w-full" />
                )}
              </section>

              <div
                ref={dividerRef}
                className="w-1.5 shrink-0 cursor-col-resize bg-border hover:bg-primary/60"
                aria-label="Resize preview"
                role="separator"
              />

              <section
                className="relative min-w-0 overflow-auto bg-black/60"
                style={{ width: `${(1 - split) * 100}%` }}
              >
                <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-background/80 px-3 py-1.5 text-[11px] uppercase tracking-widest text-muted-foreground backdrop-blur">
                  ascii · {result ? `${result.cols}×${result.rows}` : "…"} ·
                  <label className="ml-auto flex items-center gap-2 normal-case tracking-normal">
                    font
                    <input
                      type="range"
                      min={4}
                      max={14}
                      step={1}
                      value={opts.fontSize}
                      onChange={(e) => setOpts((o) => ({ ...o, fontSize: +e.target.value }))}
                      className="accent-[color:var(--primary)]"
                    />
                    <span className="w-6 text-right text-foreground">{opts.fontSize}px</span>
                  </label>
                </div>
                <div className="p-3">
                  {result &&
                    (opts.color && colouredHtml ? (
                      <div
                        className="ascii-preview"
                        style={{ fontSize: `${opts.fontSize}px` }}
                        dangerouslySetInnerHTML={{ __html: colouredHtml }}
                      />
                    ) : (
                      <pre
                        className="ascii-preview text-primary"
                        style={{ fontSize: `${opts.fontSize}px`, textShadow: "0 0 6px currentColor" }}
                      >
                        {result.chars.join("\n")}
                      </pre>
                    ))}
                </div>
              </section>
            </div>
          )}
        </main>
      </div>

      <StatusBar result={result} status={status} sourceMeta={sourceMeta} />

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={onFileInput}
      />
    </div>
  );
}

function Header({ hasImage, onOpen }: { hasImage: boolean; onOpen: () => void }) {
  return (
    <header className="flex h-11 shrink-0 items-center gap-3 border-b border-border bg-sidebar px-4 text-sm">
      <span className="text-primary" style={{ textShadow: "0 0 8px currentColor" }}>
        ▍
      </span>
      <span className="font-semibold tracking-wide">asciify</span>
      <span className="text-muted-foreground">— png → ascii, entirely in-browser</span>
      <div className="ml-auto flex items-center gap-2">
        {hasImage && (
          <button
            onClick={onOpen}
            className="rounded border border-border bg-secondary px-2 py-1 text-xs text-secondary-foreground hover:border-primary hover:text-primary"
          >
            open another…
          </button>
        )}
      </div>
    </header>
  );
}

function DropZone({
  placeholder,
  dragging,
  onDrop,
  onDragOver,
  onDragLeave,
  onClick,
}: {
  placeholder: string[];
  dragging: boolean;
  onDrop: (e: DragEvent) => void;
  onDragOver: (e: DragEvent) => void;
  onDragLeave: () => void;
  onClick: () => void;
}) {
  return (
    <div
      className={`flex flex-1 items-center justify-center p-6 transition-colors ${
        dragging ? "bg-primary/10" : ""
      }`}
      onDrop={onDrop}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onClick={onClick}
      role="button"
      tabIndex={0}
    >
      <div
        className={`relative flex h-full w-full max-w-3xl cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed p-10 text-center transition-all ${
          dragging ? "border-primary terminal-glow" : "border-border hover:border-primary/60"
        }`}
      >
        <pre className="ascii-preview text-primary text-sm sm:text-base">
          {placeholder.join("\n")}
        </pre>
        <p className="mt-6 text-xs text-muted-foreground">
          drop · click · <kbd className="rounded border border-border px-1">⌘V</kbd>{" "}
          to paste from clipboard
        </p>
      </div>
    </div>
  );
}

function Controls({
  opts,
  setOpts,
  disabled,
}: {
  opts: Options;
  setOpts: (u: (o: Options) => Options) => void;
  disabled: boolean;
}) {
  const set = <K extends keyof Options>(k: K, v: Options[K]) =>
    setOpts((o) => ({ ...o, [k]: v }));
  return (
    <div className={disabled ? "opacity-60" : ""}>
      <h3 className="mb-2 text-xs uppercase tracking-widest text-muted-foreground">grid</h3>
      <Slider
        label="width"
        min={40}
        max={400}
        step={2}
        value={opts.targetCols}
        onChange={(v) => set("targetCols", v)}
        suffix="cols"
      />
      <Slider
        label="gamma"
        min={0.3}
        max={3}
        step={0.05}
        value={opts.gamma}
        onChange={(v) => set("gamma", v)}
      />

      <h3 className="mt-5 mb-2 text-xs uppercase tracking-widest text-muted-foreground">ramp</h3>
      <div className="flex flex-wrap gap-1">
        {(["detailed", "blocks", "binary", "custom"] as const).map((k) => (
          <button
            key={k}
            onClick={() => set("rampKey", k)}
            className={`rounded border px-2 py-1 text-xs ${
              opts.rampKey === k
                ? "border-primary bg-primary/15 text-primary"
                : "border-border bg-secondary text-secondary-foreground hover:border-primary/60"
            }`}
          >
            {k}
          </button>
        ))}
      </div>
      {opts.rampKey === "custom" && (
        <input
          value={opts.customRamp}
          onChange={(e) => set("customRamp", e.target.value)}
          spellCheck={false}
          placeholder="dark → light"
          className="mt-2 w-full rounded border border-border bg-input px-2 py-1 font-mono text-sm outline-none focus:border-primary"
        />
      )}
      <p className="mt-1 text-[11px] text-muted-foreground">
        current: <span className="text-foreground">{opts.rampKey === "custom" ? opts.customRamp : RAMPS[opts.rampKey]}</span>
      </p>
      <Toggle label="invert" checked={opts.invert} onChange={(v) => set("invert", v)} />

      <h3 className="mt-5 mb-2 text-xs uppercase tracking-widest text-muted-foreground">quality</h3>
      <Toggle label="floyd–steinberg dither" checked={opts.dither} onChange={(v) => set("dither", v)} />
      <Toggle label="colour" checked={opts.color} onChange={(v) => set("color", v)} />
      <Toggle label="sobel edges" checked={opts.edges} onChange={(v) => set("edges", v)} />
      {opts.edges && (
        <Slider
          label="edge blend"
          min={0}
          max={1}
          step={0.02}
          value={opts.edgeStrength}
          onChange={(v) => set("edgeStrength", v)}
        />
      )}
    </div>
  );
}

function Slider({
  label,
  min,
  max,
  step,
  value,
  onChange,
  suffix,
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (v: number) => void;
  suffix?: string;
}) {
  return (
    <label className="mt-2 block">
      <div className="mb-0.5 flex items-center justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="text-foreground">
          {Number.isInteger(step) ? value : value.toFixed(2)} {suffix ?? ""}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(+e.target.value)}
        className="w-full accent-[color:var(--primary)]"
      />
    </label>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="mt-2 flex cursor-pointer items-center justify-between gap-2 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <button
        type="button"
        onClick={() => onChange(!checked)}
        aria-pressed={checked}
        className={`h-5 w-9 rounded-full border transition-colors ${
          checked ? "border-primary bg-primary/40" : "border-border bg-secondary"
        }`}
      >
        <span
          className={`block h-3.5 w-3.5 translate-y-[1px] rounded-full transition-transform ${
            checked ? "translate-x-[20px] bg-primary" : "translate-x-[3px] bg-muted-foreground"
          }`}
        />
      </button>
    </label>
  );
}

function ExportBtn({
  children,
  onClick,
  disabled,
  className = "",
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`rounded border border-border bg-secondary px-2 py-1.5 text-xs text-secondary-foreground transition-colors hover:border-primary hover:text-primary disabled:cursor-not-allowed disabled:opacity-40 ${className}`}
    >
      {children}
    </button>
  );
}

function StatusBar({
  result,
  status,
  sourceMeta,
}: {
  result: AsciiResult | null;
  status: string;
  sourceMeta: { w: number; h: number; name: string } | null;
}) {
  return (
    <footer className="flex h-7 shrink-0 items-center gap-4 border-t border-border bg-sidebar px-4 text-[11px] uppercase tracking-widest text-muted-foreground">
      <span>
        status: <span className="text-foreground">{status}</span>
      </span>
      {sourceMeta && (
        <span>
          src <span className="text-foreground">{sourceMeta.w}×{sourceMeta.h}</span>
        </span>
      )}
      {result && (
        <>
          <span>
            grid <span className="text-foreground">{result.cols}×{result.rows}</span>
          </span>
          <span>
            render <span className="text-foreground">{result.ms.toFixed(1)}ms</span>
          </span>
        </>
      )}
      <span className="ml-auto">asciify · offline · web worker</span>
    </footer>
  );
}