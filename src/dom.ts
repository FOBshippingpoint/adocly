type EventsFor<T> = T extends HTMLElement
  ? HTMLElementEventMap
  : T extends Document
    ? DocumentEventMap
    : T extends Window
      ? WindowEventMap
      : T extends MediaQueryList
        ? MediaQueryListEventMap
        : Record<string, Event>;

declare global {
  interface EventTarget {
    on<T extends EventTarget, K extends keyof EventsFor<T> & string>(
      this: T,
      type: K,
      listener: (this: T, event: EventsFor<T>[K]) => void,
      options?: boolean | AddEventListenerOptions,
    ): void;
    off<T extends EventTarget, K extends keyof EventsFor<T> & string>(
      this: T,
      type: K,
      listener: (this: T, event: EventsFor<T>[K]) => void,
      options?: boolean | EventListenerOptions,
    ): void;
  }
  interface Element {
    $: Element["querySelector"];
    $$<T extends Element = HTMLElement>(selector: string): T[];
  }
  interface DocumentFragment {
    $: DocumentFragment["querySelector"];
    $$<T extends Element = HTMLElement>(selector: string): T[];
  }
}

EventTarget.prototype.on = Element.prototype.addEventListener;
EventTarget.prototype.off = Element.prototype.removeEventListener;
Element.prototype.$ = Element.prototype.querySelector;
Element.prototype.$$ = function <T extends Element = HTMLElement>(
  selector: string,
): T[] {
  return [...this.querySelectorAll<T>(selector)];
};
DocumentFragment.prototype.$ = DocumentFragment.prototype.querySelector;
DocumentFragment.prototype.$$ = function <T extends Element = HTMLElement>(
  selector: string,
): T[] {
  return [...this.querySelectorAll<T>(selector)];
};

export const $ = document.querySelector.bind(document);
export const $$ = (selector: string) => [
  ...document.querySelectorAll<HTMLElement>(selector),
];
