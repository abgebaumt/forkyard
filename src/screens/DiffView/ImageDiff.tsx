/**
 * Image diff: side by side, swipe, onion skin and pixel difference. The pictures come as data URLs
 * from the core (`FileDiff::Image`). SVG is shown through <img> like every other format, never inline.
 */
import { ImageOff } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { FileDiff } from "../../core";
import { formatBytes } from "../../app/format";
import { SegmentedControl } from "../../ui/Field";
import { Slider } from "../../ui/Slider";
import { cn } from "../../ui/cn";
import { locale, t } from "../../i18n";
import {
  canCompare,
  effectiveMode,
  hexToRgb,
  loadImageMode,
  MAX_DIFF_PIXELS,
  modeOptions,
  pixelDifference,
  sameSize,
  saveImageMode,
  SMALL_IMAGE_PX,
  stackFrameStyle,
  stackGeometry,
  type ImageMode,
  type Pixels,
  type Rgb,
  type Size,
} from "./imageDiffModel";

type ImageDiff = Extract<FileDiff, { kind: "image" }>;
/** Natural size; null while loading, "failed" if the browser cannot decode the picture. */
type Natural = Size | "failed" | null;

const size = (bytes: number | null) => (bytes === null ? "–" : formatBytes(bytes));
const dimensions = (value: Size) => t("diff.image.dimensions", { width: value.width, height: value.height });
const isSmall = (value: Size) => value.width < SMALL_IMAGE_PX && value.height < SMALL_IMAGE_PX;

function useNaturalSize(url: string | null): Natural {
  const [natural, setNatural] = useState<Natural>(null);
  useEffect(() => {
    setNatural(null);
    if (!url) return;
    let live = true;
    const image = new Image();
    image.onload = () => {
      if (live) setNatural({ width: image.naturalWidth, height: image.naturalHeight });
    };
    image.onerror = () => {
      if (live) setNatural("failed");
    };
    image.src = url;
    return () => {
      live = false;
    };
  }, [url]);
  return natural;
}

// ---------------------------------------------------------------------------
// Side by side
// ---------------------------------------------------------------------------

function ImagePane({ title, url, bytes, tone, alt }: { title: string; url: string | null; bytes: number | null; tone: "old" | "new"; alt: string }) {
  const [natural, setNatural] = useState<Size | null>(null);
  const [failed, setFailed] = useState(false);
  return (
    <figure data-image-pane={tone} className="m-0 flex min-h-0 min-w-0 flex-1 flex-col">
      <figcaption className="flex h-control-lg shrink-0 items-center gap-2 border-b border-border bg-surface px-3 text-sm">
        <span className={cn("font-medium", tone === "old" ? "text-danger" : "text-success")}>{title}</span>
        {url ? (
          <span className="min-w-0 truncate text-text-muted tabular-nums">
            {natural ? `${dimensions(natural)} · ` : ""}
            {size(bytes)}
          </span>
        ) : null}
      </figcaption>
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-surface-sunken p-4">
        {url && !failed ? (
          <img
            src={url}
            alt={alt}
            draggable={false}
            // Small images (icons) are shown enlarged, with crisp pixel edges instead of blurred.
            className={cn("gc-checker max-h-full max-w-full border border-border object-contain", natural && isSmall(natural) && "gc-pixelated min-w-48")}
            onLoad={(event) => setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
            onError={() => setFailed(true)}
          />
        ) : (
          <div className="flex flex-col items-center gap-2 text-center text-sm text-text-muted">
            <ImageOff className="size-6" aria-hidden />
            <span>{failed ? t("diff.image.failed") : tone === "old" ? t("diff.image.noOld") : t("diff.image.deleted")}</span>
          </div>
        )}
      </div>
    </figure>
  );
}

function Unavailable({ text }: { text: string }) {
  return (
    <div role="status" className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 bg-surface-sunken text-sm text-text-muted">
      <ImageOff className="size-6" aria-hidden />
      <span>{text}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Swipe and onion skin
// ---------------------------------------------------------------------------

interface StackViewProps {
  mode: "swipe" | "onion";
  oldUrl: string;
  newUrl: string;
  before: Size;
  after: Size;
  name: string;
  /** Swipe: position of the divider; onion skin: opacity of the new version (0–100). */
  position: number;
}

function StackView({ mode, oldUrl, newUrl, before, after, name, position }: StackViewProps) {
  const geometry = stackGeometry(before, after);
  const placed = (share: Size) => ({ width: `${share.width}%`, height: `${share.height}%` });
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-surface-sunken p-4" style={{ containerType: "size" }}>
      <div data-image-stack={mode} className={cn("gc-checker relative border border-border", isSmall(geometry) && "gc-pixelated")} style={stackFrameStyle(geometry)}>
        <div className="absolute inset-0">
          <img src={oldUrl} alt={t("diff.image.oldAlt", { name })} draggable={false} className="absolute top-0 left-0 max-w-none" style={placed(geometry.before)} />
        </div>
        <div className="absolute inset-0" style={mode === "swipe" ? { clipPath: `inset(0 0 0 ${position}%)` } : { opacity: position / 100 }}>
          <img src={newUrl} alt={t("diff.image.newAlt", { name })} draggable={false} className="absolute top-0 left-0 max-w-none" style={placed(geometry.after)} />
        </div>
        {mode === "swipe" ? <div aria-hidden className="absolute inset-y-0 w-px bg-accent" style={{ left: `${position}%` }} /> : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pixel difference
// ---------------------------------------------------------------------------

type DifferenceState =
  | { kind: "computing" }
  | { kind: "ready"; changed: number; total: number; small: boolean }
  | { kind: "tooLarge" }
  | { kind: "unavailable" };

async function loadImage(url: string): Promise<HTMLImageElement> {
  const image = new Image();
  image.src = url;
  await image.decode();
  return image;
}

/** Throws a SecurityError if the engine counts the picture as foreign (some do so for SVG). */
function pixelsOf(image: HTMLImageElement): Pixels {
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("no 2d context");
  context.drawImage(image, 0, 0);
  return { width: canvas.width, height: canvas.height, data: context.getImageData(0, 0, canvas.width, canvas.height).data };
}

/** The `danger` token as RGB; the canvas normalises other colour notations to hex. */
function highlightColor(): Rgb | null {
  const value = getComputedStyle(document.documentElement).getPropertyValue("--gc-danger").trim();
  const direct = hexToRgb(value);
  if (direct) return direct;
  const context = document.createElement("canvas").getContext("2d");
  if (!context) return null;
  context.fillStyle = value;
  return hexToRgb(String(context.fillStyle));
}

function DifferenceView({ oldUrl, newUrl, name }: { oldUrl: string; newUrl: string; name: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState<DifferenceState>({ kind: "computing" });
  useEffect(() => {
    let live = true;
    setState({ kind: "computing" });
    const run = async (): Promise<DifferenceState> => {
      const [oldImage, newImage] = await Promise.all([loadImage(oldUrl), loadImage(newUrl)]);
      const before = { width: oldImage.naturalWidth, height: oldImage.naturalHeight };
      const after = { width: newImage.naturalWidth, height: newImage.naturalHeight };
      // SVG without its own size has no pixel grid to compare.
      if (!before.width || !before.height || !after.width || !after.height) return { kind: "unavailable" };
      if (!canCompare(before, after)) return { kind: "tooLarge" };
      const color = highlightColor();
      if (!color) return { kind: "unavailable" };
      const result = pixelDifference(pixelsOf(oldImage), pixelsOf(newImage), color);
      const canvas = canvasRef.current;
      const context = canvas?.getContext("2d");
      if (!live || !canvas || !context) return { kind: "unavailable" };
      canvas.width = result.width;
      canvas.height = result.height;
      context.putImageData(new ImageData(result.data, result.width, result.height), 0, 0);
      return { kind: "ready", changed: result.changed, total: result.width * result.height, small: isSmall(result) };
    };
    run().then(
      (next) => {
        if (live) setState(next);
      },
      () => {
        if (live) setState({ kind: "unavailable" });
      },
    );
    return () => {
      live = false;
    };
  }, [oldUrl, newUrl]);

  let summary: string;
  if (state.kind === "computing") summary = t("diff.image.computing");
  else if (state.kind === "tooLarge") summary = t("diff.image.tooLarge", { limit: new Intl.NumberFormat(locale()).format(MAX_DIFF_PIXELS) });
  else if (state.kind === "unavailable") summary = t("diff.image.unavailable");
  else if (state.changed === 0) summary = t("diff.image.identical");
  else {
    const percent = new Intl.NumberFormat(locale(), { style: "percent", maximumFractionDigits: 2 }).format(state.changed / state.total);
    summary = t("diff.image.changed", { count: state.changed, percent });
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <p role="status" data-image-difference={state.kind} className="shrink-0 border-b border-border bg-surface px-3 py-1 text-sm text-text-muted">
        {summary}
      </p>
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-surface-sunken p-4">
        <canvas
          ref={canvasRef}
          role="img"
          aria-label={t("diff.image.differenceAlt", { name })}
          className={cn("gc-checker max-h-full max-w-full border border-border", state.kind !== "ready" && "hidden", state.kind === "ready" && state.small && "gc-pixelated min-w-48")}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

export function ImageDiffView({ diff }: { diff: ImageDiff }) {
  const name = diff.path.slice(diff.path.lastIndexOf("/") + 1);
  const hasOld = diff.oldDataUrl !== null;
  const hasNew = diff.newDataUrl !== null;
  const [wanted, setWanted] = useState<ImageMode>(loadImageMode);
  const [position, setPosition] = useState(50);
  const before = useNaturalSize(diff.oldDataUrl);
  const after = useNaturalSize(diff.newDataUrl);
  const mode = effectiveMode(wanted, hasOld, hasNew);
  const urls = diff.oldDataUrl && diff.newDataUrl ? { old: diff.oldDataUrl, new: diff.newDataUrl } : null;
  const known = before && after && before !== "failed" && after !== "failed" ? { before, after } : null;
  const percent = new Intl.NumberFormat(locale(), { style: "percent" }).format(position / 100);

  const choose = (next: ImageMode) => {
    setWanted(next);
    saveImageMode(next);
  };

  let body: ReactNode;
  if (mode === "side" || !urls) {
    body = (
      <div className="flex min-h-0 flex-1 divide-x divide-border">
        <ImagePane title={t("diff.before")} tone="old" url={diff.oldDataUrl} bytes={diff.oldSize} alt={t("diff.image.oldAlt", { name })} />
        <ImagePane title={t("diff.after")} tone="new" url={diff.newDataUrl} bytes={diff.newSize} alt={t("diff.image.newAlt", { name })} />
      </div>
    );
  } else if (before === "failed" || after === "failed") {
    body = <Unavailable text={t("diff.image.failed")} />;
  } else if (mode === "difference") {
    body = <DifferenceView oldUrl={urls.old} newUrl={urls.new} name={name} />;
  } else if (!known) {
    body = <div className="min-h-0 flex-1 bg-surface-sunken" />;
  } else {
    body = <StackView mode={mode} oldUrl={urls.old} newUrl={urls.new} before={known.before} after={known.after} name={name} position={position} />;
  }

  return (
    <div data-diff-kind="image" data-image-mode={mode} className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-control-lg shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-b border-border bg-surface px-3 py-1 text-sm">
        <SegmentedControl label={t("diff.image.modeLabel")} value={mode} options={modeOptions(hasOld, hasNew)} onValueChange={choose} />
        {mode === "swipe" || mode === "onion" ? (
          <span className="flex items-center gap-2 text-text-muted">
            {mode === "swipe" ? <span>{t("diff.before")}</span> : null}
            <Slider label={mode === "swipe" ? t("diff.image.swipePosition") : t("diff.image.opacity")} value={position} onValueChange={setPosition} valueText={percent} />
            {mode === "swipe" ? <span>{t("diff.after")}</span> : <span className="tabular-nums">{percent}</span>}
          </span>
        ) : null}
        {mode !== "side" && known && !sameSize(known.before, known.after) ? (
          <span data-image-size-note="" className="text-text-muted">
            {t("diff.image.sizeDiffers", { before: dimensions(known.before), after: dimensions(known.after) })}
          </span>
        ) : null}
      </div>
      {body}
    </div>
  );
}
