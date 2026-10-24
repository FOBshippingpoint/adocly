import Asciidoctor from "@asciidoctor/core";
import hljs from "highlight.js/lib/common";
import { Idiomorph } from "idiomorph";
import "@asciidoctor/core/dist/css/asciidoctor.css";
import lightTheme from "highlight.js/styles/github.css?url";
import darkTheme from "highlight.js/styles/github-dark.css?url";
import "./style.css";
import { Database, type Snapshot } from "./database";
import { HashShare } from "./hash-share";
import { debounce } from "./debounce";

import { $, $$ } from "./dom";

const asciidoctor = Asciidoctor();

const DEFAULT_CONTENT = `= AsciiDoc Document
:toc:

== Section

Write AsciiDoc on the left. Rendered with the default Asciidoctor stylesheet on the right.

NOTE: Small documents automatically sync to the URL \`#\` hash for sharing.

[source,js]
----
console.log("Plain browser JavaScript");
----
`;

const database = new Database();
const imageCache = new Map<string, string>();
const state = {
  split: 50,
  viewMode: "split",
  desktopViewMode: "split",
  theme: "light",
  saveTimer: undefined as number | undefined,
  snapshotTimer: undefined as number | undefined,
  previewRequest: 0,
  lastSnapshot: 0,
  shareTimer: undefined as number | undefined,
};
const source = $<HTMLTextAreaElement>("#source-editor")!;
const preview = $<HTMLElement>("#preview")!;
const layout = $<HTMLElement>("#editor-layout")!;
const splitter = $<HTMLElement>("#splitter")!;
const viewButtons = $$("[data-view]");
const viewSwitch = $<HTMLElement>("#view-switch")!;

function setSplit(value: number) {
  state.split = Math.max(15, Math.min(Number(value) || 50, 85));
  layout.style.setProperty("--split", `${state.split}%`);
  splitter.setAttribute("aria-valuenow", String(Math.round(state.split)));
}

function setViewMode(mode: string) {
  state.viewMode = mode;
  if (!matchMedia("(max-width: 700px)").matches) state.desktopViewMode = mode;
  layout.dataset.viewMode = mode;
  viewSwitch.dataset.mode = mode;
  viewButtons.forEach((button) => {
    const active = button.dataset.view === mode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

function setTheme(theme: string) {
  state.theme = theme;
  document.body.dataset.theme = theme;
  $<HTMLElement>("#theme-button")!.classList.toggle("active", theme === "dark");
  $<HTMLElement>("#theme-button")!.setAttribute(
    "aria-pressed",
    String(theme === "dark"),
  );
  $<HTMLLinkElement>("#highlight-theme")!.href =
    theme === "dark" ? darkTheme : lightTheme;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function loadImageData(name: string) {
  if (imageCache.has(name)) return imageCache.get(name);
  const blob = await database.getImage(name);
  if (!blob) return null;
  const dataUrl = typeof blob === "string" ? blob : await blobToDataUrl(blob);
  imageCache.set(name, dataUrl);
  return dataUrl;
}

async function cacheImages(text: string) {
  const names = [...text.matchAll(/image::?(img-[a-z0-9]+\.[a-z0-9]+)/gi)].map(
    (match) => match[1],
  );
  await Promise.all(names.map((name) => loadImageData(name)));
}

async function renderPreview(text: string, request: number) {
  await cacheImages(text);
  if (request !== state.previewRequest) return;

  const html = asciidoctor.convert(text, {
    safe: "safe",
    attributes: { showtitle: true, "source-highlighter": "highlight.js" },
  }) as string;

  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => {
      if (request !== state.previewRequest) {
        return resolve();
      }
      Idiomorph.morph(preview, html, { morphStyle: "innerHTML" });
      preview
        .$$<HTMLElement>("pre code")
        .forEach((code) => hljs.highlightElement(code));
      preview.$$<HTMLImageElement>("img").forEach((image) => {
        const name = image.getAttribute("src");
        const dataUrl = name && imageCache.get(name);
        if (dataUrl) {
          image.src = dataUrl;
        }
      });
      resolve();
    });
  });
}

const debouncedLargePreview = debounce(
  (text: string, request: number) => renderPreview(text, request),
  {
    waitMs: 100,
  },
);

function schedulePreview(text: string) {
  const request = ++state.previewRequest;
  if (text.length < 10000) {
    renderPreview(text, request);
    return;
  }
  debouncedLargePreview(text, request);
}

function expandImageReferences(text: string) {
  return text.replace(
    /(image::?)(img-[a-z0-9]+\.[a-z0-9]+)(\[[^\]]*\])/gi,
    (match, prefix, name, attributes) => {
      const dataUrl = imageCache.get(name);
      return dataUrl ? `${prefix}${dataUrl}${attributes}` : match;
    },
  );
}

async function syncDocument(text: string) {
  schedulePreview(text);
  const encoded = await HashShare.encode(text);
  $<HTMLElement>("#share-button")!.hidden = !encoded.canShare;
  if (encoded.canShare) {
    try {
      history.replaceState(null, "", encoded.hash);
    } catch (_) {}
  } else if (location.hash) {
    try {
      history.replaceState(null, "", location.pathname + location.search);
    } catch (_) {}
  }
}

async function recordSnapshot(text: string) {
  const snapshot = await database.addSnapshot(text);
  state.lastSnapshot = Date.now();
  renderHistory(await database.getHistory(), snapshot?.id);
}

function renderHistory(items: Snapshot[], activeId: number | null = null) {
  const menu = $<HTMLElement>("#history-menu")!;
  menu.innerHTML = items
    .map(
      (item) =>
        `<div class="history-item ${item.id === activeId ? "current" : ""}" data-id="${item.id}"><span>${new Date(item.timestamp).toLocaleTimeString()}</span><span class="sub">${item.content.length}c</span></div>`,
    )
    .join("");
  menu.$$<HTMLElement>("[data-id]").forEach((item) =>
    item.on("click", async () => {
      const snapshot = items.find(
        (entry) => entry.id === Number(item.dataset.id),
      )!;
      source.value = snapshot.content;
      await database.setSetting("content", snapshot.content);
      await syncDocument(snapshot.content);
      menu.classList.remove("open");
      $<HTMLElement>("#history-button")!.classList.remove("active");
    }),
  );
}

function insertTextAtCursor(text: string) {
  const start = source.selectionStart;
  const prefix = start > 0 && source.value[start - 1] !== "\n" ? "\n" : "";
  source.setRangeText(`${prefix}${text}`, start, source.selectionEnd, "end");
  source.dispatchEvent(new Event("input", { bubbles: true }));
}

async function addImages(files: File[]) {
  for (const file of files) {
    const extension = (file.type.split("/")[1] || "png").replace(
      /[^a-z0-9]/gi,
      "",
    );
    const name = `img-${Date.now().toString(36)}.${extension}`;
    imageCache.set(name, await blobToDataUrl(file));
    await database.saveImage(name, file);
    insertTextAtCursor(`image::${name}[]\n`);
  }
}

function bindSource() {
  source.on("input", () => {
    const text = source.value;
    syncDocument(text);
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(
      () => database.setSetting("content", text),
      200,
    );
    if (Date.now() - state.lastSnapshot > 15000) recordSnapshot(text);
    else {
      clearTimeout(state.snapshotTimer);
      state.snapshotTimer = setTimeout(() => recordSnapshot(text), 1500);
    }
  });
  source.on("copy", (event) => {
    const selected = source.value.slice(
      source.selectionStart,
      source.selectionEnd,
    );
    if (!selected || !/image::?img-/i.test(selected)) return;
    event.preventDefault();
    event.clipboardData?.setData("text/plain", expandImageReferences(selected));
  });
  source.on("cut", (event) => {
    const selected = source.value.slice(
      source.selectionStart,
      source.selectionEnd,
    );
    if (!selected || !/image::?img-/i.test(selected)) return;
    event.preventDefault();
    event.clipboardData?.setData("text/plain", expandImageReferences(selected));
    source.setRangeText("", source.selectionStart, source.selectionEnd, "end");
    source.dispatchEvent(new Event("input", { bubbles: true }));
  });
  source.on("paste", (event) => {
    const files = [...(event.clipboardData?.items || [])]
      .filter((item) => item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (files.length) {
      event.preventDefault();
      addImages(files);
    }
  });
  source.on("dragover", (event) => {
    if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
  });
  source.on("drop", (event) => {
    const files = [...(event.dataTransfer?.files || [])].filter((file) =>
      file.type.startsWith("image/"),
    );
    if (files.length) {
      event.preventDefault();
      addImages(files);
    }
  });
}

function bindSplitter() {
  const mobile = matchMedia("(max-width: 700px)");
  let pointerId: number | null = null;
  const updateOrientation = () =>
    splitter.setAttribute(
      "aria-orientation",
      mobile.matches ? "horizontal" : "vertical",
    );
  updateOrientation();
  mobile.on("change", (event) => {
    updateOrientation();
    setViewMode(event.matches ? "write" : state.desktopViewMode);
  });
  splitter.on("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    pointerId = event.pointerId;
    splitter.setPointerCapture(pointerId);
    splitter.focus();
    layout.classList.add("resizing");
  });
  splitter.on("pointermove", (event) => {
    if (event.pointerId !== pointerId) return;
    const bounds = layout.getBoundingClientRect();
    setSplit(
      ((mobile.matches
        ? event.clientY - bounds.top
        : event.clientX - bounds.left) /
        (mobile.matches ? bounds.height : bounds.width)) *
        100,
    );
  });
  const stop = (event: PointerEvent) => {
    if (event.pointerId !== pointerId) return;
    if (splitter.hasPointerCapture(pointerId))
      splitter.releasePointerCapture(pointerId);
    pointerId = null;
    layout.classList.remove("resizing");
  };
  splitter.on("pointerup", stop);
  splitter.on("pointercancel", stop);
  splitter.on("lostpointercapture", stop);
  splitter.on("dblclick", () => setSplit(50));
  splitter.on("keydown", (event) => {
    const down = mobile.matches ? "ArrowUp" : "ArrowLeft";
    const up = mobile.matches ? "ArrowDown" : "ArrowRight";
    if (![down, up, "Home", "End", "Enter"].includes(event.key)) return;
    event.preventDefault();
    if (event.key === "Home") setSplit(15);
    else if (event.key === "End") setSplit(85);
    else if (event.key === "Enter") setSplit(50);
    else
      setSplit(
        state.split + (event.key === down ? -1 : 1) * (event.shiftKey ? 10 : 2),
      );
  });
}

function bindToolbar() {
  const historyButton = $<HTMLElement>("#history-button")!;
  const menu = $<HTMLElement>("#history-menu")!;
  historyButton.on("click", async () => {
    const open = menu.classList.toggle("open");
    historyButton.classList.toggle("active", open);
    if (open) renderHistory(await database.getHistory());
  });
  $<HTMLElement>("#share-button")!.on("click", async () => {
    const encoded = await HashShare.encode(source.value);
    if (!encoded.canShare) return;
    const url = location.href.split("#")[0] + encoded.hash;
    await navigator.clipboard.writeText(url);
    const button = $<HTMLElement>("#share-button")!;
    button.classList.add("active");
    clearTimeout(state.shareTimer);
    state.shareTimer = setTimeout(
      () => button.classList.remove("active"),
      1200,
    );
  });
  $<HTMLElement>("#theme-button")!.on("click", async () => {
    const theme = state.theme === "dark" ? "light" : "dark";
    setTheme(theme);
    await database.setSetting("theme", theme);
  });
  viewButtons.forEach((button) =>
    button.on("click", () => {
      setViewMode(button.dataset.view!);
    }),
  );
  document.on("pointerdown", (event) => {
    if (
      menu.classList.contains("open") &&
      !event.composedPath().includes(menu) &&
      !event.composedPath().includes(historyButton)
    ) {
      menu.classList.remove("open");
      historyButton.classList.remove("active");
    }
  });
  $<HTMLElement>("#preview")!.on("copy", (event) => {
    const selection = getSelection();
    if (!selection || selection.isCollapsed) return;
    const container = document.createElement("div");
    for (let i = 0; i < selection.rangeCount; i++)
      container.appendChild(selection.getRangeAt(i).cloneContents());
    event.preventDefault();
    event.clipboardData?.setData("text/html", container.innerHTML);
    event.clipboardData?.setData("text/plain", selection.toString());
  });
}

async function loadFromHash() {
  if (!location.hash.startsWith("#z=")) return false;
  try {
    const text = await HashShare.decode(location.hash);
    if (!text) return false;
    source.value = text;
    await database.setSetting("content", text);
    await recordSnapshot(text);
    await syncDocument(text);
    return true;
  } catch (_) {
    return false;
  }
}

async function init() {
  setSplit(50);
  setViewMode(matchMedia("(max-width: 700px)").matches ? "write" : "split");
  bindSource();
  bindSplitter();
  bindToolbar();
  const savedTheme = await database.getSetting("theme");
  setTheme(
    savedTheme ||
      (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"),
  );
  if (!(await loadFromHash())) {
    source.value = (await database.getSetting("content", DEFAULT_CONTENT))!;
    await recordSnapshot(source.value);
    await syncDocument(source.value);
  }
  window.on("hashchange", loadFromHash);
}

init();
