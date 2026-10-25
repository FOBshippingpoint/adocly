import Asciidoctor from "@asciidoctor/core";
import { type DocHandle, isValidAutomergeUrl } from "@automerge/automerge-repo/slim";
import hljs from "highlight.js/lib/common";
import { Idiomorph } from "idiomorph";
import "@asciidoctor/core/dist/css/asciidoctor.css";
import lightTheme from "highlight.js/styles/github.css?url";
import darkTheme from "highlight.js/styles/github-dark.css?url";
import "./style.css";
import { CollaboratorManager } from "./collaborators";
import { Database, type DocSchema, type Snapshot, type Theme, type ViewMode } from "./database";
import { HashShare } from "./hash-share";
import { debounce } from "./debounce";

import { $, $$, forkTemplate } from "./dom";

const asciidoctor = Asciidoctor();
let collaborators: CollaboratorManager | null = null;
let localStartCursor: string | null = null;
let localEndCursor: string | null = null;

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
  splitRatio: 50,
  viewMode: "split" as ViewMode,
  desktopViewMode: "split" as ViewMode,
  theme: "light" as Theme,
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

function saveLayout() {
  database.setSetting("layout", {
    mode: state.viewMode,
    splitRatio: state.splitRatio,
  });
}

function setSplitRatio(value: number) {
  state.splitRatio = Math.max(15, Math.min(Number(value) || 50, 85));
  layout.style.setProperty("--split", `${state.splitRatio}%`);
  splitter.setAttribute("aria-valuenow", String(Math.round(state.splitRatio)));
  saveLayout();
  collaborators?.refreshCarets();
}

function setViewMode(mode: ViewMode) {
  state.viewMode = mode;
  if (!matchMedia("(max-width: 700px)").matches) state.desktopViewMode = mode;
  layout.dataset.viewMode = mode;
  viewSwitch.dataset.mode = mode;
  viewButtons.forEach((button) => {
    const active = button.dataset.view === mode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  saveLayout();
  collaborators?.refreshCarets();
}

function setTheme(theme: Theme) {
  state.theme = theme;
  document.body.dataset.theme = theme;
  $<HTMLElement>("#theme-button")!.classList.toggle("active", theme === "dark");
  $<HTMLElement>("#theme-button")!.setAttribute("aria-pressed", String(theme === "dark"));
  $<HTMLLinkElement>("#highlight-theme")!.href = theme === "dark" ? darkTheme : lightTheme;
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
  const names = [...text.matchAll(/image::?images\/(img_[a-z0-9]+\.[a-z0-9]+)/gi)].map(
    ([, name]) => name,
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
      preview.$$<HTMLElement>("pre code").forEach((code) => hljs.highlightElement(code));
      preview.$$<HTMLImageElement>("img").forEach((image) => {
        const src = image.getAttribute("src");
        const name = src?.startsWith("images/") ? src.slice("images/".length) : null;
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
    void renderPreview(text, request);
    return;
  }
  debouncedLargePreview(text, request);
}

function expandImageReferences(text: string) {
  return text.replace(
    /(image::?)images\/(img_[a-z0-9]+\.[a-z0-9]+)(\[[^\]]*\])/gi,
    (match, prefix, name, attributes) => {
      const dataUrl = imageCache.get(name);
      return dataUrl ? `${prefix}${dataUrl}${attributes}` : match;
    },
  );
}

function updateLocalCursors() {
  if (document.activeElement !== source) return;
  localStartCursor = database.getCursor(source.selectionStart ?? 0);
  localEndCursor = database.getCursor(source.selectionEnd ?? 0);
}

function syncUrlHash() {
  if (!database.isShared()) return;
  const docUrl = database.getDocUrl();
  if (docUrl) location.hash = `#${docUrl}`;
}

async function syncDocument(text: string) {
  schedulePreview(text);
  syncUrlHash();
}

function recordSnapshot(text: string) {
  const snapshot = database.addSnapshot(text);
  state.lastSnapshot = Date.now();
  const menu = $<HTMLElement>("#history-menu");
  if (menu?.classList.contains("open")) {
    renderHistory(database.getHistory(), snapshot?.id);
  }
}

function renderHistory(items: Snapshot[], activeId: string | null = null) {
  const menu = $<HTMLElement>("#history-menu")!;
  const frag = document.createDocumentFragment();
  const dates = items.map((snapshot) => new Date(snapshot.timestamp));
  const spansDates = new Set(dates.map((date) => date.toDateString())).size > 1;
  for (const [index, snapshot] of items.entries()) {
    const item = forkTemplate<HTMLDivElement>("history-item-template");
    item.classList.toggle("current", snapshot.id === activeId);
    item.dataset.id = snapshot.id;
    const date = dates[index];
    item.$<HTMLSpanElement>(".time")!.textContent = spansDates
      ? `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`
      : date.toLocaleTimeString();
    item.$<HTMLSpanElement>(".sub")!.textContent = `${snapshot.content.length}c`;
    item.on("click", async () => {
      source.value = snapshot.content;
      recordSnapshot(snapshot.content);
      collaborators?.notifyContentChange();
      await syncDocument(snapshot.content);
      menu.classList.remove("open");
      $<HTMLElement>("#history-button")!.classList.remove("active");
    });
    frag.appendChild(item);
  }
  menu.replaceChildren(frag);
}

function bindHandle(handle: DocHandle<DocSchema>) {
  handle.on("change", ({ doc }) => {
    const nextText = doc?.content ?? "";
    if (source.value !== nextText) {
      const isFocused = document.activeElement === source;
      const fallbackStart = source.selectionStart ?? 0;
      const fallbackEnd = source.selectionEnd ?? 0;
      const dir = source.selectionDirection ?? "none";
      const nextStart =
        database.getCursorPosition(localStartCursor) ?? Math.min(fallbackStart, nextText.length);
      const nextEnd =
        database.getCursorPosition(localEndCursor) ?? Math.min(fallbackEnd, nextText.length);

      source.value = nextText;
      if (isFocused) {
        source.setSelectionRange(Math.min(nextStart, nextEnd), Math.max(nextStart, nextEnd), dir);
        updateLocalCursors();
      }
      schedulePreview(nextText);
    }
    collaborators?.refreshCarets();
    const menu = $<HTMLElement>("#history-menu");
    if (menu?.classList.contains("open")) {
      renderHistory(database.getHistory());
    }
  });
}

function insertTextAtCursor(text: string) {
  const start = source.selectionStart;
  const prefix = start > 0 && source.value[start - 1] !== "\n" ? "\n" : "";
  source.setRangeText(`${prefix}${text}`, start, source.selectionEnd, "end");
  source.dispatchEvent(new Event("input", { bubbles: true }));
}

async function addImages(files: File[]) {
  for (const file of files) {
    const extension = (file.type.split("/")[1] || "png").replace(/[^a-z0-9]/gi, "");
    const name = `img_${Date.now().toString(36)}.${extension}`;
    imageCache.set(name, await blobToDataUrl(file));
    await database.saveImage(name, file);
    insertTextAtCursor(`image::images/${name}[]\n`);
  }
}

function bindSource() {
  source.on("input", () => {
    const text = source.value;
    database.updateContent(text);
    updateLocalCursors();
    void syncDocument(text);
    collaborators?.notifyContentChange();
    if (Date.now() - state.lastSnapshot > 15000) recordSnapshot(text);
    else {
      clearTimeout(state.snapshotTimer);
      state.snapshotTimer = setTimeout(() => recordSnapshot(text), 1500);
    }
  });
  source.on("keyup", updateLocalCursors);
  source.on("pointerup", updateLocalCursors);
  source.on("select", updateLocalCursors);
  source.on("focus", updateLocalCursors);
  source.on("copy", (event) => {
    const selected = source.value.slice(source.selectionStart, source.selectionEnd);
    if (!selected || !/image::?images\/img_/i.test(selected)) return;
    event.preventDefault();
    event.clipboardData?.setData("text/plain", expandImageReferences(selected));
  });
  source.on("cut", (event) => {
    const selected = source.value.slice(source.selectionStart, source.selectionEnd);
    if (!selected || !/image::?images\/img_/i.test(selected)) return;
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
      void addImages(files);
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
      void addImages(files);
    }
  });
}

function bindSplitter() {
  const mobile = matchMedia("(max-width: 700px)");
  let pointerId: number | null = null;
  const updateOrientation = () =>
    splitter.setAttribute("aria-orientation", mobile.matches ? "horizontal" : "vertical");
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
    setSplitRatio(
      ((mobile.matches ? event.clientY - bounds.top : event.clientX - bounds.left) /
        (mobile.matches ? bounds.height : bounds.width)) *
        100,
    );
  });
  const stop = (event: PointerEvent) => {
    if (event.pointerId !== pointerId) return;
    if (splitter.hasPointerCapture(pointerId)) splitter.releasePointerCapture(pointerId);
    pointerId = null;
    layout.classList.remove("resizing");
  };
  splitter.on("pointerup", stop);
  splitter.on("pointercancel", stop);
  splitter.on("lostpointercapture", stop);
  splitter.on("dblclick", () => setSplitRatio(50));
  splitter.on("keydown", (event) => {
    const down = mobile.matches ? "ArrowUp" : "ArrowLeft";
    const up = mobile.matches ? "ArrowDown" : "ArrowRight";
    if (![down, up, "Home", "End", "Enter"].includes(event.key)) {
      return;
    }
    event.preventDefault();
    switch (event.key) {
      case "Home":
        setSplitRatio(15);
        break;
      case "End":
        setSplitRatio(85);
        break;
      case "Enter":
        setSplitRatio(50);
        break;
      default:
        setSplitRatio(state.splitRatio + (event.key === down ? -1 : 1) * (event.shiftKey ? 10 : 2));
    }
  });
}

function renderShareMenu() {
  const shared = database.isShared();
  $<HTMLElement>("#share-action-button")!.hidden = shared;
  $<HTMLElement>("#share-link-row")!.hidden = !shared;
  $<HTMLInputElement>("#share-url-input")!.value = shared
    ? `${location.href.split("#")[0]}#${database.getDocUrl()}`
    : "";
}

function syncCollabVisibility() {
  const shared = database.isShared();
  const collabButton = $<HTMLElement>("#collab-button")!;
  const collabMenu = $<HTMLElement>("#collab-menu")!;
  collabButton.hidden = !shared;
  $<HTMLElement>("#collab-divider")!.hidden = !shared;
  if (!shared) {
    collabMenu.classList.remove("open");
    collabButton.classList.remove("active");
    collabButton.setAttribute("aria-expanded", "false");
  }
}

function closeShareMenu() {
  $("#share-menu")!.classList.remove("open");
  $("#share-button")!.classList.remove("active");
  $("#share-button")!.setAttribute("aria-expanded", "false");
}

function bindToolbar() {
  const historyButton = $<HTMLElement>("#history-button")!;
  const menu = $<HTMLElement>("#history-menu")!;
  $("#collab-button")!.on("click", closeShareMenu);
  historyButton.on("click", () => {
    closeShareMenu();
    const collabMenu = $<HTMLElement>("#collab-menu");
    const collabButton = $<HTMLElement>("#collab-button");
    if (collabMenu?.classList.contains("open")) {
      collabMenu.classList.remove("open");
      collabButton?.classList.remove("active");
      collabButton?.setAttribute("aria-expanded", "false");
    }
    const open = menu.classList.toggle("open");
    historyButton.classList.toggle("active", open);
    if (open) renderHistory(database.getHistory());
  });
  const shareButton = $("#share-button")!;
  const shareMenu = $("#share-menu")!;
  shareButton.on("click", () => {
    $("#collab-menu")!.classList.remove("open");
    $("#collab-button")!.classList.remove("active");
    $("#collab-button")!.setAttribute("aria-expanded", "false");
    menu.classList.remove("open");
    historyButton.classList.remove("active");
    const open = shareMenu.classList.toggle("open");
    shareButton.classList.toggle("active", open);
    shareButton.setAttribute("aria-expanded", String(open));
    if (open) renderShareMenu();
  });
  $("#share-action-button")!.on("click", () => {
    database.enableSharing();
    syncCollabVisibility();
    syncUrlHash();
    renderShareMenu();
  });
  $("#share-copy-button")!.on("click", async () => {
    await navigator.clipboard.writeText($<HTMLInputElement>("#share-url-input")!.value);
    const button = $("#share-copy-button")!;
    button.classList.add("active");
    button.setAttribute("aria-label", "Copied");
    button.setAttribute("title", "Copied");
    clearTimeout(state.shareTimer);
    state.shareTimer = setTimeout(() => {
      button.classList.remove("active");
      button.setAttribute("aria-label", "Copy link");
      button.setAttribute("title", "Copy link");
    }, 1200);
  });
  $<HTMLElement>("#theme-button")!.on("click", () => {
    const theme = state.theme === "dark" ? "light" : "dark";
    setTheme(theme);
    database.setSetting("theme", theme);
  });
  viewButtons.forEach((button) =>
    button.on("click", () => {
      setViewMode(button.dataset.view as ViewMode);
    }),
  );
  document.on("pointerdown", (event) => {
    if (!event.composedPath().includes(shareMenu) && !event.composedPath().includes(shareButton)) {
      closeShareMenu();
    }
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
  syncCollabVisibility();
  const rawHash = location.hash.slice(1);
  if (rawHash && isValidAutomergeUrl(rawHash)) {
    if (database.getDocUrl() === rawHash) return true;
    const handle = await database.openDocument(rawHash);
    if (!handle) return false;
    syncCollabVisibility();
    bindHandle(handle);
    collaborators?.attachHandle(handle);
    source.value = database.getContent(DEFAULT_CONTENT);
    await syncDocument(source.value);
    return true;
  }

  if (!location.hash.startsWith("#z=")) return false;
  try {
    const text = await HashShare.decode(location.hash);
    if (!text) return false;
    source.value = text;
    recordSnapshot(text);
    await syncDocument(text);
    return true;
  } catch {
    return false;
  }
}

async function init() {
  const initialHash = location.hash.slice(1);
  const handle = await database.init(DEFAULT_CONTENT, initialHash);
  bindHandle(handle);
  source.value = database.getContent(DEFAULT_CONTENT);
  syncCollabVisibility();

  const savedLayout = database.getSetting("layout", {
    mode: matchMedia("(max-width: 700px)").matches ? "write" : "split",
    splitRatio: 50,
  });
  state.viewMode = savedLayout.mode;
  setSplitRatio(savedLayout.splitRatio);
  setViewMode(savedLayout.mode);
  bindSource();
  bindSplitter();
  bindToolbar();
  const savedTheme = database.getSetting("theme");
  setTheme(savedTheme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));

  if (!(await loadFromHash())) {
    source.value = database.getContent(DEFAULT_CONTENT);
    recordSnapshot(source.value);
    await syncDocument(source.value);
  } else {
    source.value = database.getContent(DEFAULT_CONTENT);
    await syncDocument(source.value);
  }

  collaborators = new CollaboratorManager({
    database,
    source,
    preview,
  });

  window.on("hashchange", loadFromHash);
}

void init();
