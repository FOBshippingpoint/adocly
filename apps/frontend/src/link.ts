const LINK_PROTOCOLS = new Set(["http:", "https:", "ftp:", "irc:", "file:", "mailto:"]);
const COMPLEX_LINK_TOKENS = [
  "[",
  "]",
  " ",
  "\t",
  "__",
  "*",
  "++",
  "`",
  "##",
  "^",
  "~",
  "{",
  "}",
  "<",
  ">",
  "--",
  "...",
];

export function isValidLink(text: string): boolean {
  if (!text || text.includes("\n") || text.includes("\r") || !URL.canParse(text)) {
    return false;
  }

  const url = new URL(text);
  if (!LINK_PROTOCOLS.has(url.protocol)) {
    return false;
  }
  if (url.protocol === "mailto:") {
    return Boolean(url.pathname);
  }
  if (url.protocol === "file:") {
    return text.toLowerCase().startsWith("file://");
  }
  return Boolean(url.host);
}

export function isComplexLink(url: string): boolean {
  return COMPLEX_LINK_TOKENS.some((token) => url.includes(token));
}

export function toAsciiDocLink(selectedText: string, possibleUrl: string): string | null {
  const url = possibleUrl.trim();
  if (!selectedText || !isValidLink(url)) {
    return null;
  }

  const label = selectedText.replaceAll("]", "\\]");
  if (!isComplexLink(url)) {
    return `${url}[${label}]`;
  }

  if (url.includes("++") || url.endsWith("+")) {
    return `link:pass:[${url.replaceAll("]", "\\]")}][${label}]`;
  } else {
    return `link:++${url}++[${label}]`;
  }
}
