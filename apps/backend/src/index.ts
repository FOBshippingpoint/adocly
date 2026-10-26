import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Hono } from "hono";
import { cors } from "hono/cors";
export { SyncServer } from "./server";

export interface Bindings {
  ASSETS: R2Bucket;
  UPLOAD_MODE?: "local" | "presigned";
  R2_ACCOUNT_ID: string;
  R2_BUCKET_NAME: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  SYNC: DurableObjectNamespace;
}

const app = new Hono<{ Bindings: Bindings }>();

app.use("/assets/*", cors());

app.get("/assets/:id", async (c) => {
  const object = await c.env.ASSETS.get(c.req.param("id"));
  if (!object) return c.notFound();
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(object.body, { headers });
});

const imageExtensions = new Map([
  ["image/png", "png"],
  ["image/gif", "gif"],
  ["image/jpeg", "jpg"],
  ["image/webp", "webp"],
  ["image/avif", "avif"],
  ["image/apng", "apng"],
  ["image/bmp", "bmp"],
  ["image/tiff", "tiff"],
  ["image/x-icon", "ico"],
  ["image/svg+xml", "svg"],
]);

function randomId64(): string {
  const [uint64] = crypto.getRandomValues(new BigUint64Array(1));
  return uint64.toString(36).padStart(13, "0");
}

app.post("/assets/upload", async (c) => {
  const body = await c.req.json<{ contentType?: unknown }>().catch(() => null);
  const contentType = body?.contentType as string;
  const extension = imageExtensions.get(contentType);
  if (!extension) {
    return c.json({ error: "Unsupported image type" }, 400);
  }

  const key = `${randomId64()}.${extension}`;
  c.header("Cache-Control", "no-store");
  if (c.env.UPLOAD_MODE === "local") {
    return c.json({ key, uploadUrl: new URL(`/assets/${key}`, c.req.url).href });
  }
  const r2 = new S3Client({
    region: "auto",
    endpoint: `https://${c.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: c.env.R2_ACCESS_KEY_ID,
      secretAccessKey: c.env.R2_SECRET_ACCESS_KEY,
    },
  });
  const uploadUrl = await getSignedUrl(
    r2,
    new PutObjectCommand({ Bucket: c.env.R2_BUCKET_NAME, Key: key, ContentType: contentType }),
    { expiresIn: 300, signableHeaders: new Set(["content-type"]) },
  );
  return c.json({ key, uploadUrl });
});

app.put("/assets/:id", async (c) => {
  if (c.env.UPLOAD_MODE !== "local") {
    c.header("Allow", "GET");
    return c.body(null, 405);
  }
  const contentType = c.req.header("Content-Type") ?? "";
  const extension = imageExtensions.get(contentType);
  if (!extension) {
    return c.json({ error: "Unsupported image type" }, 400);
  }
  const key = c.req.param("id");
  if (!/^[a-z0-9]{13}\.[a-z0-9]+$/.test(key) || !key.endsWith(`.${extension}`)) {
    return c.json({ error: "Invalid image key" }, 400);
  }
  const object = await c.env.ASSETS.put(key, await c.req.arrayBuffer(), {
    httpMetadata: { contentType },
  });
  return c.json({ key: object.key }, 201);
});

app.get("*", async (c) => {
  if (c.req.header("Upgrade")?.toLowerCase() === "websocket") {
    const id = c.env.SYNC.idFromName("default");
    return await c.env.SYNC.get(id).fetch(c.req.raw);
  }
  return c.text("Hi");
});

export default app;
