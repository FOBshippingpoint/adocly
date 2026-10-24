export function debounce<Args extends unknown[]>(
  callback: (...args: Args) => void,
  { isLeadingEdge = false, waitMs = 3000 }: { isLeadingEdge?: boolean; waitMs?: number } = {},
) {
  let timeoutId: number | undefined;
  return (...args: Args) => {
    const isCallNow = isLeadingEdge && !timeoutId;
    clearTimeout(timeoutId);
    timeoutId = window.setTimeout(() => {
      timeoutId = undefined;
      if (!isLeadingEdge) callback(...args);
    }, waitMs);
    if (isCallNow) callback(...args);
  };
}
