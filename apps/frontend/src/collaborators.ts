import { type DocHandle, type PeerId, Presence } from "@automerge/automerge-repo/slim";
import type { Database, DocSchema } from "./database";
import { $, forkTemplate } from "./dom";

export const COLLAB_COLORS = [
  "#2b7de9",
  "#e03e3e",
  "#0d9488",
  "#8b5cf6",
  "#d97706",
  "#db2777",
  "#16a34a",
  "#ea580c",
] as const;

export const COLLAB_EMOJIS = [
  "🐱",
  "🐶",
  "🦊",
  "🐼",
  "🐸",
  "🐨",
  "🐯",
  "🐙",
  "🦉",
  "🐧",
  "🦋",
  "🐢",
] as const;

export const COLLAB_EMOJI_NAMES: Record<string, string> = {
  "🐱": "Cat",
  "🐶": "Dog",
  "🦊": "Fox",
  "🐼": "Panda",
  "🐸": "Frog",
  "🐨": "Koala",
  "🐯": "Tiger",
  "🐙": "Octopus",
  "🦉": "Owl",
  "🐧": "Penguin",
  "🦋": "Butterfly",
  "🐢": "Turtle",
};

export interface ProfilePayload {
  emoji: string;
  color: string;
}

export interface CaretPayload {
  start: number;
  end: number;
  direction: "forward" | "backward" | "none";
  startCursor?: string | null;
  endCursor?: string | null;
  updatedAt: number;
}

export interface PointerPayload {
  area: "source" | "preview" | "viewport";
  xRatio: number;
  yRatio: number;
  visible: boolean;
  updatedAt: number;
}

export interface PresenceStatePayload {
  profile?: ProfilePayload;
  caret?: CaretPayload | null;
  pointer?: PointerPayload | null;
}

export interface CollaboratorState {
  id: string;
  emoji: string;
  color: string;
  isSelf: boolean;
  caret: CaretPayload | null;
  pointer: PointerPayload | null;
  lastSeen: number;
}

interface CaretLayout {
  caretLeft: number;
  caretTop: number;
  caretHeight: number;
  selectionRects: Array<{ left: number; top: number; width: number; height: number }>;
}

function lineNumberAt(text: string, index: number): number {
  const clamped = Math.max(0, Math.min(index, text.length));
  let line = 1;
  for (let i = 0; i < clamped; i++) {
    if (text.charCodeAt(i) === 10) line++;
  }
  return line;
}

export class CollaboratorManager {
  private database: Database;
  private source: HTMLTextAreaElement;
  private preview: HTMLElement;
  private self: CollaboratorState;
  private peers = new Map<string, CollaboratorState>();
  private presence: Presence<PresenceStatePayload> | null = null;
  private caretLayer: HTMLElement;
  private cursorLayer: HTMLElement;
  private mirror: HTMLDivElement;
  private collabButton: HTMLButtonElement;
  private collabAvatars: HTMLElement;
  private collabMenu: HTMLElement;
  private collabEmojiPicker: HTMLElement;
  private collabList: HTMLElement;
  private highlightedPeerId: string | null = null;

  constructor(options: { database: Database; source: HTMLTextAreaElement; preview: HTMLElement }) {
    this.database = options.database;
    this.source = options.source;
    this.preview = options.preview;
    this.caretLayer = $<HTMLElement>("#caret-layer")!;
    this.cursorLayer = $<HTMLElement>("#cursor-layer")!;
    this.collabButton = $<HTMLButtonElement>("#collab-button")!;
    this.collabAvatars = $<HTMLElement>("#collab-avatars")!;
    this.collabMenu = $<HTMLElement>("#collab-menu")!;
    this.collabEmojiPicker = $<HTMLElement>("#collab-emoji-picker")!;
    this.collabList = $<HTMLElement>("#collab-list")!;

    const peerId =
      this.database.getRepo()?.peerId ?? `peer-${Math.random().toString(36).slice(2, 10)}`;
    const defaultColor = COLLAB_COLORS[Math.floor(Math.random() * COLLAB_COLORS.length)];
    const defaultEmoji = COLLAB_EMOJIS[Math.floor(Math.random() * COLLAB_EMOJIS.length)];
    const saved = this.database.getSetting("identity", {
      emoji: defaultEmoji,
      color: defaultColor,
    })!;

    this.self = {
      id: peerId,
      emoji: saved.emoji,
      color: saved.color,
      isSelf: true,
      caret: null,
      pointer: null,
      lastSeen: Date.now(),
    };

    this.mirror = document.createElement("div");
    this.mirror.className = "caret-mirror";
    this.mirror.setAttribute("aria-hidden", "true");
    this.source.parentElement!.appendChild(this.mirror);

    this.initUI();
    this.saveProfile();
    this.bindEvents();

    const handle = this.database.getHandle();
    if (handle) {
      this.attachHandle(handle);
    }

    this.database.getRepo()?.networkSubsystem.on("peer", () => {
      window.setTimeout(() => {
        this.presence?.broadcast("profile", this.getProfilePayload());
        this.presence?.broadcast("caret", this.self.caret);
        this.presence?.broadcast("pointer", this.self.pointer);
      }, 300);
    });

    this.renderParticipants();
    this.renderCarets();
    this.renderCursors();

    window.setInterval(() => {
      if (this.peers.size > 0) {
        this.renderCarets();
        this.updateParticipantStatuses();
      }
    }, 1000);
  }

  private getProfilePayload(): ProfilePayload {
    return {
      emoji: this.self.emoji,
      color: this.self.color,
    };
  }

  private saveProfile() {
    this.database.setSetting("identity", {
      emoji: this.self.emoji,
      color: this.self.color,
    });
  }

  private initUI() {
    const frag = document.createDocumentFragment();
    for (const emoji of COLLAB_EMOJIS) {
      const btn = forkTemplate<HTMLButtonElement>("collab-emoji-button-template");
      btn.dataset.emoji = emoji;
      btn.setAttribute("aria-label", emoji);
      btn.setAttribute("aria-pressed", String(emoji === this.self.emoji));
      btn.textContent = emoji;
      frag.appendChild(btn);
    }
    this.collabEmojiPicker.replaceChildren(frag);
  }

  public attachHandle(handle: DocHandle<DocSchema>) {
    if (this.presence) {
      this.presence.stop();
      this.presence = null;
    }
    this.peers.clear();

    const presence = new Presence<PresenceStatePayload>({ handle });
    this.presence = presence;

    const syncPeer = (peerId: PeerId) => {
      if (peerId === this.self.id) return;
      const peerState = presence.getPeerStates().value[peerId];
      if (!peerState) return;
      const prev = this.peers.get(peerId);
      const profile = peerState.value?.profile;
      const emoji = profile?.emoji ?? prev?.emoji;
      if (!emoji) return;
      const color = profile?.color || prev?.color || COLLAB_COLORS[0];

      this.peers.set(peerId, {
        id: peerId,
        emoji,
        color,
        isSelf: false,
        caret: peerState.value?.caret ?? prev?.caret ?? null,
        pointer: peerState.value?.pointer ?? prev?.pointer ?? null,
        lastSeen: Date.now(),
      });

      if (!prev || prev.emoji !== emoji || prev.color !== color) {
        this.renderParticipants();
      } else {
        this.updateParticipantStatuses();
      }
      this.renderCarets();
      this.renderCursors();
    };

    presence.on("snapshot", (msg) => {
      syncPeer(msg.peerId);
    });

    presence.on("update", (msg) => {
      syncPeer(msg.peerId);
    });

    presence.on("heartbeat", (msg) => {
      const existing = this.peers.get(msg.peerId);
      if (existing) {
        existing.lastSeen = Date.now();
      } else {
        syncPeer(msg.peerId);
      }
    });

    presence.on("goodbye", (msg) => {
      if (this.peers.delete(msg.peerId)) {
        this.renderParticipants();
        this.renderCarets();
        this.renderCursors();
      }
    });

    presence.on("pruning", (msg) => {
      let changed = false;
      for (const peerId of msg.pruned) {
        if (this.peers.delete(peerId)) {
          changed = true;
        }
      }
      if (changed) {
        this.renderParticipants();
        this.renderCarets();
        this.renderCursors();
      }
    });

    presence.start({
      initialState: {
        profile: this.getProfilePayload(),
        caret: this.self.caret,
        pointer: this.self.pointer,
      },
      heartbeatMs: 30_000,
      peerTtlMs: 90_000,
    });

    window.setTimeout(() => {
      if (this.presence === presence && presence.running) {
        presence.broadcast("profile", this.getProfilePayload());
      }
    }, 600);

    this.renderParticipants();
    this.renderCarets();
    this.renderCursors();
  }

  public notifyContentChange() {
    this.captureSelfCaret();
    this.presence?.broadcast("caret", this.self.caret);
    this.renderCarets();
    this.updateParticipantStatuses();
  }

  public refreshCarets() {
    this.renderCarets();
    this.updateParticipantStatuses();
  }

  private captureSelfCaret() {
    if (document.activeElement !== this.source) return;
    const start = this.source.selectionStart ?? 0;
    const end = this.source.selectionEnd ?? 0;
    this.self.caret = {
      start,
      end,
      direction: this.source.selectionDirection ?? "none",
      startCursor: this.database.getCursor(start),
      endCursor: this.database.getCursor(end),
      updatedAt: Date.now(),
    };
  }

  private bindEvents() {
    const onSelectionChange = () => {
      this.captureSelfCaret();
      this.presence?.broadcast("caret", this.self.caret);
      this.updateParticipantStatuses();
    };

    this.source.on("keyup", onSelectionChange);
    this.source.on("pointerup", onSelectionChange);
    this.source.on("focus", onSelectionChange);
    this.source.on("select", onSelectionChange);
    document.on("selectionchange", () => {
      if (document.activeElement === this.source) {
        onSelectionChange();
      }
    });

    this.source.on("scroll", () => {
      this.renderCarets();
    });

    window.on("resize", () => {
      this.renderCarets();
      this.renderCursors();
    });

    let lastPointerSent = 0;
    document.on("pointermove", (event) => {
      const now = performance.now();
      if (now - lastPointerSent < 40) return;
      lastPointerSent = now;

      const sourceRect = this.source.getBoundingClientRect();
      const previewRect = this.preview.getBoundingClientRect();

      let area: PointerPayload["area"] = "viewport";
      let xRatio = event.clientX / Math.max(1, window.innerWidth);
      let yRatio = event.clientY / Math.max(1, window.innerHeight);

      if (
        sourceRect.width > 0 &&
        event.clientX >= sourceRect.left &&
        event.clientX <= sourceRect.right &&
        event.clientY >= sourceRect.top &&
        event.clientY <= sourceRect.bottom
      ) {
        area = "source";
        xRatio = (event.clientX - sourceRect.left) / sourceRect.width;
        yRatio = (event.clientY - sourceRect.top) / sourceRect.height;
      } else if (
        previewRect.width > 0 &&
        event.clientX >= previewRect.left &&
        event.clientX <= previewRect.right &&
        event.clientY >= previewRect.top &&
        event.clientY <= previewRect.bottom
      ) {
        area = "preview";
        xRatio = (event.clientX - previewRect.left) / previewRect.width;
        yRatio = (event.clientY - previewRect.top) / previewRect.height;
      }

      this.self.pointer = {
        area,
        xRatio: Math.max(0, Math.min(1, xRatio)),
        yRatio: Math.max(0, Math.min(1, yRatio)),
        visible: true,
        updatedAt: Date.now(),
      };
      this.presence?.broadcast("pointer", this.self.pointer);
    });

    document.documentElement.on("pointerleave", () => {
      if (this.self.pointer) {
        this.self.pointer = {
          ...this.self.pointer,
          visible: false,
          updatedAt: Date.now(),
        };
        this.presence?.broadcast("pointer", this.self.pointer);
      }
    });

    window.on("pagehide", () => {
      this.presence?.stop();
    });

    window.on("beforeunload", () => {
      this.presence?.stop();
    });

    this.collabButton.on("click", () => {
      const historyMenu = $<HTMLElement>("#history-menu");
      const historyButton = $<HTMLElement>("#history-button");
      if (historyMenu?.classList.contains("open")) {
        historyMenu.classList.remove("open");
        historyButton?.classList.remove("active");
      }
      const open = this.collabMenu.classList.toggle("open");
      this.collabButton.classList.toggle("active", open);
      this.collabButton.setAttribute("aria-expanded", String(open));
      if (open) {
        this.renderParticipants();
      }
    });

    document.on("pointerdown", (event) => {
      const path = event.composedPath();
      if (
        this.collabMenu.classList.contains("open") &&
        !path.includes(this.collabMenu) &&
        !path.includes(this.collabButton)
      ) {
        this.collabMenu.classList.remove("open");
        this.collabButton.classList.remove("active");
        this.collabButton.setAttribute("aria-expanded", "false");
      }
    });

    this.collabEmojiPicker.$$<HTMLButtonElement>("button").forEach((btn) => {
      btn.on("click", () => {
        this.self.emoji = btn.dataset.emoji!;
        this.collabEmojiPicker.$$<HTMLButtonElement>("button").forEach((b) => {
          b.setAttribute("aria-pressed", String(b === btn));
        });
        this.saveProfile();
        this.presence?.broadcast("profile", this.getProfilePayload());
        this.renderParticipants();
      });
    });
  }

  private resolvePeerSelection(caret: CaretPayload): {
    start: number;
    end: number;
    head: number;
  } {
    const startIdx = this.database.getCursorPosition(caret.startCursor) ?? caret.start;
    const endIdx = this.database.getCursorPosition(caret.endCursor) ?? caret.end;
    const start = Math.min(startIdx, endIdx);
    const end = Math.max(startIdx, endIdx);
    const head = caret.direction === "backward" ? start : end;
    return { start, end, head };
  }

  private getAllParticipants(): CollaboratorState[] {
    return [this.self, ...this.peers.values()];
  }

  private getStatusLabel(peer: CollaboratorState): string {
    if (peer.caret) {
      const { start, end, head } = this.resolvePeerSelection(peer.caret);
      const line = lineNumberAt(this.source.value, head);
      return start !== end ? `Ln ${line} · Sel` : `Ln ${line}`;
    }
    if (peer.pointer?.area === "preview") {
      return "Preview";
    }
    return "";
  }

  private updateParticipantStatuses() {
    for (const peer of this.getAllParticipants()) {
      const statusEl = this.collabList.$<HTMLElement>(`[data-status-for="${peer.id}"]`);
      if (statusEl) {
        statusEl.textContent = this.getStatusLabel(peer);
      }
    }
  }

  private renderParticipants() {
    const all = this.getAllParticipants();
    const visibleAvatars = all.slice(0, 4);
    const overflowCount = all.length - visibleAvatars.length;

    const avatarsFrag = document.createDocumentFragment();
    for (const peer of visibleAvatars) {
      const label = COLLAB_EMOJI_NAMES[peer.emoji] ?? peer.emoji;
      const avatar = forkTemplate<HTMLSpanElement>("collab-avatar-template");
      if (peer.isSelf) avatar.classList.add("is-self");
      avatar.style.setProperty("--collab-color", peer.color);
      avatar.title = peer.isSelf ? `${label} (You)` : label;
      avatar.textContent = peer.emoji;
      avatarsFrag.appendChild(avatar);
    }
    if (overflowCount > 0) {
      const more = forkTemplate<HTMLSpanElement>("collab-avatar-template");
      more.classList.add("collab-avatar-more");
      more.title = `${overflowCount} more`;
      more.textContent = `+${overflowCount}`;
      avatarsFrag.appendChild(more);
    }
    this.collabAvatars.replaceChildren(avatarsFrag);

    const listFrag = document.createDocumentFragment();
    for (const peer of all) {
      const label = COLLAB_EMOJI_NAMES[peer.emoji] ?? peer.emoji;
      const item = forkTemplate<HTMLDivElement>("collab-item-template");
      if (peer.isSelf) item.classList.add("is-self");
      item.dataset.peerId = peer.id;
      item.title = peer.isSelf ? `${label} (You)` : `Jump to ${label}`;

      const avatar = item.$<HTMLSpanElement>(".collab-avatar")!;
      avatar.style.setProperty("--collab-color", peer.color);
      avatar.textContent = peer.emoji;

      const nameEl = item.$<HTMLSpanElement>(".collab-item-name")!;
      nameEl.textContent = peer.isSelf ? `${label} (You)` : label;

      const statusEl = item.$<HTMLSpanElement>(".collab-item-status")!;
      statusEl.dataset.statusFor = peer.id;
      statusEl.textContent = this.getStatusLabel(peer);

      item.on("click", () => {
        const peerId = item.dataset.peerId;
        if (!peerId) return;
        const target = peerId === this.self.id ? this.self : this.peers.get(peerId);
        if (target) {
          this.focusCollaborator(target);
        }
      });

      listFrag.appendChild(item);
    }
    this.collabList.replaceChildren(listFrag);
  }

  private focusCollaborator(peer: CollaboratorState) {
    this.highlightedPeerId = peer.id;
    if (peer.caret) {
      const { head } = this.resolvePeerSelection(peer.caret);
      const layout = this.measureEditorCaret(this.source.value, head, head, head);
      if (layout) {
        const targetScroll = Math.max(
          0,
          layout.caretTop + this.source.scrollTop - this.source.clientHeight / 2,
        );
        this.source.scrollTo({ top: targetScroll, behavior: "smooth" });
      }
    }
    this.renderCarets();
    this.renderCursors();
    window.setTimeout(() => {
      if (this.highlightedPeerId === peer.id) {
        this.highlightedPeerId = null;
        this.renderCarets();
        this.renderCursors();
      }
    }, 1800);
  }

  private measureEditorCaret(
    text: string,
    start: number,
    end: number,
    head: number,
  ): CaretLayout | null {
    const clientWidth = this.source.clientWidth;
    if (clientWidth === 0) return null;

    this.mirror.style.width = `${clientWidth}px`;
    const clampedStart = Math.max(0, Math.min(start, text.length));
    const clampedEnd = Math.max(clampedStart, Math.min(end, text.length));
    const clampedHead = Math.max(0, Math.min(head, text.length));

    this.mirror.textContent = "";

    let caretMarker: HTMLSpanElement;
    let selectionSpan: HTMLSpanElement | null = null;

    if (clampedStart === clampedEnd) {
      const before = document.createTextNode(text.slice(0, clampedHead));
      caretMarker = document.createElement("span");
      caretMarker.textContent = "\u200b";
      const after = document.createTextNode(text.slice(clampedHead) || "\u200b");
      this.mirror.append(before, caretMarker, after);
    } else {
      const before = document.createTextNode(text.slice(0, clampedStart));
      selectionSpan = document.createElement("span");
      selectionSpan.textContent = text.slice(clampedStart, clampedEnd);
      caretMarker = document.createElement("span");
      caretMarker.textContent = "\u200b";
      const after = document.createTextNode(text.slice(clampedEnd) || "\u200b");

      if (clampedHead === clampedStart) {
        this.mirror.append(before, caretMarker, selectionSpan, after);
      } else {
        this.mirror.append(before, selectionSpan, caretMarker, after);
      }
    }

    const mirrorRect = this.mirror.getBoundingClientRect();
    const markerRect = caretMarker.getBoundingClientRect();
    const scrollLeft = this.source.scrollLeft;
    const scrollTop = this.source.scrollTop;

    const selectionRects: Array<{ left: number; top: number; width: number; height: number }> = [];
    if (selectionSpan) {
      const clientRects = selectionSpan.getClientRects();
      for (let i = 0; i < clientRects.length; i++) {
        const r = clientRects[i];
        if (r.width <= 0 || r.height <= 0) continue;
        selectionRects.push({
          left: r.left - mirrorRect.left - scrollLeft,
          top: r.top - mirrorRect.top - scrollTop,
          width: r.width,
          height: r.height,
        });
      }
    }

    return {
      caretLeft: markerRect.left - mirrorRect.left - scrollLeft,
      caretTop: markerRect.top - mirrorRect.top - scrollTop,
      caretHeight: markerRect.height || 22,
      selectionRects,
    };
  }

  public renderCarets() {
    const text = this.source.value;
    const clientWidth = this.source.clientWidth;
    const clientHeight = this.source.clientHeight;
    if (clientWidth === 0 || clientHeight === 0) {
      this.caretLayer.replaceChildren();
      return;
    }

    const now = Date.now();
    const frag = document.createDocumentFragment();

    for (const peer of this.peers.values()) {
      if (!peer.caret) continue;
      const { start, end, head } = this.resolvePeerSelection(peer.caret);
      const layout = this.measureEditorCaret(text, start, end, head);
      if (!layout) continue;

      for (const rect of layout.selectionRects) {
        if (rect.top + rect.height < 0 || rect.top > clientHeight) continue;
        const selEl = forkTemplate<HTMLDivElement>("collab-selection-template");
        selEl.style.setProperty("--collab-color", peer.color);
        selEl.style.transform = `translate3d(${rect.left.toFixed(1)}px, ${rect.top.toFixed(1)}px, 0)`;
        selEl.style.width = `${rect.width.toFixed(1)}px`;
        selEl.style.height = `${rect.height.toFixed(1)}px`;
        frag.appendChild(selEl);
      }

      if (layout.caretTop + layout.caretHeight >= 0 && layout.caretTop <= clientHeight) {
        const isHighlighted = this.highlightedPeerId === peer.id;
        const lastActive = Math.max(peer.caret.updatedAt, peer.pointer?.updatedAt ?? 0);
        const isRecentlyActive = now - lastActive < 4000 || isHighlighted;
        const isInactive = now - lastActive >= 4000 && !isHighlighted;
        const flipBelow = layout.caretTop < 24;

        const caretEl = forkTemplate<HTMLDivElement>("collab-caret-template");
        caretEl.classList.toggle("active", isRecentlyActive);
        caretEl.classList.toggle("inactive", isInactive);
        caretEl.classList.toggle("flip-below", flipBelow);
        caretEl.classList.toggle("pulsing", isHighlighted);
        caretEl.style.setProperty("--collab-color", peer.color);
        caretEl.style.transform = `translate3d(${layout.caretLeft.toFixed(1)}px, ${layout.caretTop.toFixed(1)}px, 0)`;
        caretEl.style.height = `${layout.caretHeight.toFixed(1)}px`;
        caretEl.$<HTMLSpanElement>(".collab-caret-flag")!.textContent = peer.emoji;
        frag.appendChild(caretEl);
      }
    }

    this.caretLayer.replaceChildren(frag);
  }

  private resolvePointerPosition(pointer: PointerPayload): { x: number; y: number } | null {
    if (!pointer.visible) return null;

    if (pointer.area === "source") {
      const rect = this.source.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return null;
      return {
        x: rect.left + pointer.xRatio * rect.width,
        y: rect.top + pointer.yRatio * rect.height,
      };
    }

    if (pointer.area === "preview") {
      const rect = this.preview.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return null;
      return {
        x: rect.left + pointer.xRatio * rect.width,
        y: rect.top + pointer.yRatio * rect.height,
      };
    }

    return {
      x: pointer.xRatio * window.innerWidth,
      y: pointer.yRatio * window.innerHeight,
    };
  }

  public renderCursors() {
    const activeIds = new Set<string>();

    for (const peer of this.peers.values()) {
      if (!peer.pointer || !peer.pointer.visible) continue;
      const pos = this.resolvePointerPosition(peer.pointer);
      if (!pos) continue;

      activeIds.add(peer.id);
      let cursorEl = this.cursorLayer.$<HTMLElement>(`[data-cursor-id="${peer.id}"]`);
      const emoji = peer.emoji;

      if (!cursorEl) {
        cursorEl = forkTemplate<HTMLDivElement>("collab-cursor-template");
        cursorEl.dataset.cursorId = peer.id;
        this.cursorLayer.appendChild(cursorEl);
      }

      cursorEl.style.setProperty("--collab-color", peer.color);
      cursorEl.style.transform = `translate3d(${pos.x.toFixed(1)}px, ${pos.y.toFixed(1)}px, 0)`;
      cursorEl.classList.toggle("pulsing", this.highlightedPeerId === peer.id);

      const emojiEl = cursorEl.$<HTMLElement>(".collab-cursor-emoji")!;
      if (emojiEl.textContent !== emoji) {
        emojiEl.textContent = emoji;
      }
    }

    for (const child of this.cursorLayer.$$<HTMLElement>("[data-cursor-id]")) {
      const id = child.dataset.cursorId;
      if (!id || !activeIds.has(id)) {
        child.remove();
      }
    }
  }
}
