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

EventTarget.prototype.on = function (
  type: string,
  listener: EventListener,
  options?: boolean | AddEventListenerOptions,
) {
  this.addEventListener(type, listener, options);
} as EventTarget["on"];
EventTarget.prototype.off = function (
  type: string,
  listener: EventListener,
  options?: boolean | EventListenerOptions,
) {
  this.removeEventListener(type, listener, options);
} as EventTarget["off"];
Element.prototype.$ = function (this: Element, selectors: string) {
  return this.querySelector(selectors);
} as Element["querySelector"];
Element.prototype.$$ = function <T extends Element = HTMLElement>(selector: string): T[] {
  return [...this.querySelectorAll<T>(selector)];
};
DocumentFragment.prototype.$ = function (this: DocumentFragment, selectors: string) {
  return this.querySelector(selectors);
} as DocumentFragment["querySelector"];
DocumentFragment.prototype.$$ = function <T extends Element = HTMLElement>(selector: string): T[] {
  return [...this.querySelectorAll<T>(selector)];
};

export const $ = document.querySelector.bind(document);
export const $$ = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)];

export function forkTemplate<E extends Element = HTMLElement>(templateId: string): E {
  const template = $<HTMLTemplateElement>(`template#${templateId}`);
  if (!template) {
    throw new Error(`Cannot find template element with id [ ${templateId} ]`);
  }
  const node = template.content.cloneNode(true) as DocumentFragment;
  return node.firstElementChild as E;
}
