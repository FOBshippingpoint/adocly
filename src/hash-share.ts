export class HashShare {
  static maxLength = 2000;
  static encodeBytes(bytes: Uint8Array) {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  static decodeBytes(value: string) {
    let base64 = value.replace(/-/g, "+").replace(/_/g, "/");
    while (base64.length % 4) base64 += "=";
    return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
  }
  static async encode(text: string) {
    const stream = new CompressionStream("deflate-raw");
    const writer = stream.writable.getWriter();
    writer.write(new TextEncoder().encode(text));
    writer.close();
    const bytes = new Uint8Array(await new Response(stream.readable).arrayBuffer());
    const payload = `z=${this.encodeBytes(bytes)}`;
    return { hash: `#${payload}`, canShare: payload.length <= this.maxLength };
  }
  static async decode(hash: string) {
    if (!hash.startsWith("#z=")) return null;
    const stream = new DecompressionStream("deflate-raw");
    const writer = stream.writable.getWriter();
    writer.write(this.decodeBytes(hash.slice(3)));
    writer.close();
    return new TextDecoder().decode(await new Response(stream.readable).arrayBuffer());
  }
}
