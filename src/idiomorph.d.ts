declare module "idiomorph" {
  export const Idiomorph: {
    morph(
      element: Element,
      content: string | Node,
      options: { morphStyle: "innerHTML" | "outerHTML" },
    ): Node[] | undefined;
  };
}
