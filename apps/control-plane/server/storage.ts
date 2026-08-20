import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

type StorageConfiguration = { bucket: string; region: string; endpoint?: string; forcePathStyle: boolean; accessKeyId: string; secretAccessKey: string };

function storageConfiguration(): StorageConfiguration {
  const bucket = process.env.UMOJA_OBJECT_STORAGE_BUCKET;
  const accessKeyId = process.env.UMOJA_OBJECT_STORAGE_ACCESS_KEY_ID;
  const secretAccessKey = process.env.UMOJA_OBJECT_STORAGE_SECRET_ACCESS_KEY;
  if (!bucket || !accessKeyId || !secretAccessKey) throw new Error("object storage is not configured");
  const endpoint = process.env.UMOJA_OBJECT_STORAGE_ENDPOINT;
  if (endpoint) {
    const parsed = new URL(endpoint);
    if (parsed.protocol !== "https:" && process.env.UMOJA_OBJECT_STORAGE_ALLOW_INSECURE_LOCAL !== "true") throw new Error("object storage endpoint must use HTTPS");
  }
  return { bucket, region: process.env.UMOJA_OBJECT_STORAGE_REGION ?? "us-east-1", endpoint, forcePathStyle: process.env.UMOJA_OBJECT_STORAGE_FORCE_PATH_STYLE === "true", accessKeyId, secretAccessKey };
}

function client(config: StorageConfiguration): S3Client {
  return new S3Client({ region: config.region, endpoint: config.endpoint, forcePathStyle: config.forcePathStyle, credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey } });
}
function normalizeKey(relKey: string): string {
  const key = relKey.replace(/^\/+/, "");
  if (!key || key.includes("..") || key.includes("\\")) throw new Error("invalid object key");
  return key;
}
function appendHashSuffix(relKey: string): string {
  const hash = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  const lastDot = relKey.lastIndexOf(".");
  return lastDot === -1 ? `${relKey}_${hash}` : `${relKey.slice(0, lastDot)}_${hash}${relKey.slice(lastDot)}`;
}
function localStoragePath(key: string): string { return `/storage/${encodeURIComponent(key)}`; }

export async function storageCreateUploadUrl(relKey: string, contentType: string): Promise<{ key: string; uploadUrl: string }> {
  const config = storageConfiguration();
  const key = appendHashSuffix(normalizeKey(relKey));
  const uploadUrl = await getSignedUrl(client(config), new PutObjectCommand({ Bucket: config.bucket, Key: key, ContentType: contentType }), { expiresIn: 300 });
  return { key, uploadUrl };
}

export async function storagePut(relKey: string, data: Buffer | Uint8Array | string, contentType = "application/octet-stream"): Promise<{ key: string; url: string }> {
  const config = storageConfiguration();
  const key = appendHashSuffix(normalizeKey(relKey));
  await client(config).send(new PutObjectCommand({ Bucket: config.bucket, Key: key, Body: data, ContentType: contentType }));
  return { key, url: localStoragePath(key) };
}

export async function storageGet(relKey: string): Promise<{ key: string; url: string }> {
  const key = normalizeKey(relKey);
  return { key, url: localStoragePath(key) };
}

export async function storageGetSignedUrl(relKey: string): Promise<string> {
  const config = storageConfiguration();
  const key = normalizeKey(relKey);
  return getSignedUrl(client(config), new GetObjectCommand({ Bucket: config.bucket, Key: key }), { expiresIn: 300 });
}
