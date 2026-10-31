import type { Asciidoctor, Document, Extensions } from "@asciidoctor/core";
import type { ViewMode } from "./database";

function getLineFromElement(el: Element | null | undefined): number | null {
  for (const cls of el?.classList ?? []) {
    if (cls.startsWith("data-line-")) {
      return Number(cls.slice(10));
    }
  }
  return null;
}

export function createLineTrackingRegistry(asciidoctor: Asciidoctor) {
  return asciidoctor.Extensions.create("scroll-sync", function (this: Extensions.Registry) {
    this.treeProcessor(function (this: Extensions.TreeProcessorDsl) {
      this.process((doc: Document) => {
        for (const b of doc.findBy({})) {
          const l = b.getLineNumber();
          if (l && b.getContext() !== "document") {
            b.addRole(`data-line-${l}`);
          }
        }
        return doc;
      });
    });
  });
}

function getCaretLine(textarea: HTMLTextAreaElement): number {
  return textarea.value.slice(0, textarea.selectionStart ?? 0).split("\n").length;
}

function getLineOffset(text: string, line: number): number {
  let off = 0;
  for (let l = 1; l < line; l++) {
    off = text.indexOf("\n", off) + 1;
  }
  return off;
}

type Anchor = { line: number; sourceY: number; previewY: number; height: number };

export class ScrollSync {
  private source: HTMLTextAreaElement;
  private preview: HTMLElement;
  private getViewMode: () => ViewMode;
  private sourceFlash: HTMLElement;
  private previewFlash: HTMLElement;
  private mirror: HTMLElement;
  private scrollLock: "source" | "preview" | null = null;
  private scrollLockTimer = 0;
  private lastCaretLine = 1;
  private lastSourceVal = "";
  private cachedMetrics: Array<{ top: number; height: number }> | null = null;
  private cachedAnchors: Anchor[] | null = null;

  constructor(opts: {
    source: HTMLTextAreaElement;
    preview: HTMLElement;
    getViewMode: () => ViewMode;
  }) {
    this.source = opts.source;
    this.preview = opts.preview;
    this.getViewMode = opts.getViewMode;
    this.sourceFlash = this.createFlash(opts.source.parentElement!);
    this.previewFlash = this.createFlash(opts.preview.parentElement!);
    this.mirror = Object.assign(document.createElement("div"), {
      className: "caret-mirror",
      ariaHidden: "true",
    });
    opts.source.parentElement!.appendChild(this.mirror);
    this.bindEvents();
  }

  private createFlash(parent: HTMLElement): HTMLElement {
    const el = Object.assign(document.createElement("div"), {
      className: "sync-flash",
      ariaHidden: "true",
    });
    el.on("animationend", () => el.classList.remove("flash"));
    parent.appendChild(el);
    return el;
  }

  private flash(el: HTMLElement, top: number, height: number) {
    el.style.top = `${top}px`;
    el.style.height = `${height}px`;
    el.classList.remove("flash");
    void el.offsetWidth;
    el.classList.add("flash");
  }

  private lock(driver: "source" | "preview", ms = 60) {
    this.scrollLock = driver;
    clearTimeout(this.scrollLockTimer);
    this.scrollLockTimer = window.setTimeout(() => (this.scrollLock = null), ms);
  }

  private getLineMetrics(): Array<{ top: number; height: number }> {
    const w = this.source.clientWidth;
    if (
      this.cachedMetrics &&
      this.mirror.style.width === `${w}px` &&
      this.lastSourceVal === this.source.value
    ) {
      return this.cachedMetrics;
    }
    if (w === 0) return [];
    this.mirror.style.width = `${w}px`;
    this.lastSourceVal = this.source.value;

    const frag = document.createDocumentFragment();
    for (const line of this.source.value.split("\n")) {
      const div = document.createElement("div");
      div.textContent = line || "\u200b";
      frag.appendChild(div);
    }
    this.mirror.replaceChildren(frag);

    const mTop = this.mirror.getBoundingClientRect().top;
    this.cachedMetrics = Array.from(this.mirror.children, (el) => {
      const b = el.getBoundingClientRect();
      return { top: b.top - mTop, height: b.height };
    });
    return this.cachedMetrics;
  }

  private getSourceLine(line: number): { top: number; height: number } {
    const metrics = this.getLineMetrics();
    return (
      metrics[Math.max(0, Math.min(line - 1, metrics.length - 1))] ?? {
        top: 56 + (line - 1) * 22.4,
        height: 22.4,
      }
    );
  }

  private getAnchors(): Anchor[] {
    if (this.cachedAnchors && this.lastSourceVal === this.source.value) return this.cachedAnchors;
    const previewBox = this.preview.getBoundingClientRect();
    const anchors: Anchor[] = [];

    for (const el of this.preview.$$<HTMLElement>("[class*='data-line-']")) {
      const line = getLineFromElement(el);
      if (!line) continue;
      const box = el.getBoundingClientRect();
      anchors.push({
        line,
        sourceY: this.getSourceLine(line).top,
        previewY: box.top - previewBox.top + this.preview.scrollTop,
        height: box.height,
      });
    }
    this.cachedAnchors = anchors.sort((a, b) => a.line - b.line);
    return this.cachedAnchors;
  }

  private syncScroll(from: HTMLElement, to: HTMLElement, isSourceToPreview: boolean) {
    const driver = isSourceToPreview ? "source" : "preview";
    if (this.getViewMode() !== "split" || (this.scrollLock && this.scrollLock !== driver)) return;
    this.lock(driver);

    const fromMax = from.scrollHeight - from.clientHeight;
    const toMax = to.scrollHeight - to.clientHeight;
    if (fromMax <= 0 || toMax <= 0) return;

    const progress = from.scrollTop / fromMax;
    const fromRefY = from.scrollTop + progress * from.clientHeight;
    const anchors = this.getAnchors();

    let targetToY = progress * to.scrollHeight;
    if (anchors.length > 0) {
      const prev = anchors.findLast(
        (a) => (isSourceToPreview ? a.sourceY : a.previewY) <= fromRefY,
      ) ?? { sourceY: 0, previewY: 0 };
      const next = anchors.find((a) => (isSourceToPreview ? a.sourceY : a.previewY) > fromRefY) ?? {
        sourceY: this.source.scrollHeight,
        previewY: this.preview.scrollHeight,
      };
      const [fromA, fromB] = isSourceToPreview
        ? [prev.sourceY, next.sourceY]
        : [prev.previewY, next.previewY];
      const [toA, toB] = isSourceToPreview
        ? [prev.previewY, next.previewY]
        : [prev.sourceY, next.sourceY];
      targetToY = toA + (fromB > fromA ? (fromRefY - fromA) / (fromB - fromA) : 0) * (toB - toA);
    }
    to.scrollTop = Math.max(0, Math.min(toMax, targetToY - progress * to.clientHeight));
  }

  private flashPreview(line: number) {
    const anchors = this.getAnchors();
    const best = anchors.findLast((a) => a.line <= line) ?? anchors[0];
    if (best)
      this.flash(
        this.previewFlash,
        best.previewY - this.preview.scrollTop,
        Math.max(24, best.height),
      );
  }

  private flashSource(line: number) {
    const { top, height } = this.getSourceLine(line);
    this.flash(this.sourceFlash, top - this.source.scrollTop, height);
  }

  public notifyPreviewRendered() {
    this.cachedAnchors = null;
    if (this.getViewMode() === "split" && document.activeElement === this.source) {
      this.flashPreview(getCaretLine(this.source));
    }
  }

  public capturePosition(): number {
    const el = this.getViewMode() === "preview" ? this.preview : this.source;
    return el.scrollHeight > el.clientHeight
      ? el.scrollTop / (el.scrollHeight - el.clientHeight)
      : 0;
  }

  public restorePosition(ratio: number) {
    if (this.getViewMode() === "split") {
      return this.syncScroll(this.source, this.preview, true);
    }
    const el = this.getViewMode() === "preview" ? this.preview : this.source;
    el.scrollTop = ratio * (el.scrollHeight - el.clientHeight);
  }

  private bindEvents() {
    this.source.on("scroll", () => this.syncScroll(this.source, this.preview, true));
    this.preview.on("scroll", () => this.syncScroll(this.preview, this.source, false));

    const onCaretMove = () => {
      const line = getCaretLine(this.source);
      if (line !== this.lastCaretLine) {
        this.lastCaretLine = line;
        if (this.getViewMode() === "split") this.flashPreview(line);
      }
    };
    this.source.on("keyup", onCaretMove);
    this.source.on("click", onCaretMove);

    this.preview.on("click", (e) => {
      if (this.getViewMode() !== "split") {
        return;
      }
      const target = (e.target as Element | null)?.closest<HTMLElement>("[class*='data-line-']");
      const line = getLineFromElement(target);
      if (!line) return;
      const off = getLineOffset(this.source.value, line);
      this.source.setSelectionRange(off, off);
      this.lastCaretLine = line;
      this.lock("preview", 150);
      this.source.scrollTop = Math.max(
        0,
        this.getSourceLine(line).top - this.source.clientHeight / 3,
      );
      this.flashSource(line);
    });
  }
}
