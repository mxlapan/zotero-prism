/**
 * Request signing for the cloud translation APIs.
 *
 * Amazon (Signature Version 4), Tencent Cloud (TC3-HMAC-SHA256) and Volcano
 * Engine (HMAC-SHA256) share one scheme: a canonical request, a dated
 * credential scope and a chain of HMAC-SHA256 keys; they differ only in the
 * algorithm name, the secret's prefix and the scope's last element. Alibaba
 * Cloud's RPC APIs sign the sorted query with HMAC-SHA1 instead. WebCrypto
 * only, so the same code runs in Zotero and under the tests.
 */

const encoder = new TextEncoder();

export function hex(bytes: ArrayBuffer | Uint8Array): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function base64(bytes: ArrayBuffer | Uint8Array): string {
  const data = new Uint8Array(bytes);
  let out = "";
  for (let i = 0; i < data.length; i += 3) {
    const n = (data[i] << 16) | ((data[i + 1] ?? 0) << 8) | (data[i + 2] ?? 0);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    out += i + 1 < data.length ? B64[(n >> 6) & 63] : "=";
    out += i + 2 < data.length ? B64[n & 63] : "=";
  }
  return out;
}

export async function sha256Hex(text: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
}

export async function hmac(
  hash: "SHA-256" | "SHA-1",
  key: string | ArrayBuffer | Uint8Array,
  data: string,
): Promise<ArrayBuffer> {
  const raw = typeof key === "string" ? encoder.encode(key) : key;
  const imported = await crypto.subtle.importKey("raw", raw as BufferSource, { name: "HMAC", hash }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", imported, encoder.encode(data));
}

/** RFC 3986 percent-encoding, as every one of these schemes requires. */
export function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export interface V4Request {
  /** "AWS4-HMAC-SHA256", "TC3-HMAC-SHA256" or "HMAC-SHA256" */
  algorithm: string;
  /** what the secret is prefixed with before the first HMAC: "AWS4", "TC3" or "" */
  secretPrefix: string;
  /** last element of the credential scope: "aws4_request", "tc3_request" or "request" */
  terminator: string;
  /** Tencent's scope has no region element */
  regionInScope: boolean;
  accessKey: string;
  secretKey: string;
  region: string;
  service: string;
  method: string;
  path: string;
  query?: Record<string, string>;
  /** the headers to sign, names in any case */
  headers: Record<string, string>;
  payload: string;
  /** the date part of the scope, e.g. 20150830 or 2019-02-25 */
  date: string;
  /** the request time as it appears in the string to sign */
  stamp: string;
}

/** Returns the Authorization header value for a V4-style request. */
export async function signV4(request: V4Request): Promise<string> {
  const names = Object.keys(request.headers)
    .map((name) => name.toLowerCase())
    .sort();
  const lower = Object.fromEntries(
    Object.entries(request.headers).map(([name, value]) => [name.toLowerCase(), value]),
  );
  const signedHeaders = names.join(";");
  const canonicalHeaders = names
    .map((name) => `${name}:${String(lower[name]).trim().replace(/\s+/g, " ")}\n`)
    .join("");
  const canonicalQuery = Object.keys(request.query || {})
    .sort()
    .map((key) => `${percentEncode(key)}=${percentEncode(request.query![key])}`)
    .join("&");
  const canonical = [
    request.method,
    request.path,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    await sha256Hex(request.payload),
  ].join("\n");
  const scope = [
    request.date,
    ...(request.regionInScope ? [request.region] : []),
    request.service,
    request.terminator,
  ].join("/");
  const stringToSign = [request.algorithm, request.stamp, scope, await sha256Hex(canonical)].join("\n");

  let key: ArrayBuffer | string = `${request.secretPrefix}${request.secretKey}`;
  key = await hmac("SHA-256", key, request.date);
  if (request.regionInScope) key = await hmac("SHA-256", key, request.region);
  key = await hmac("SHA-256", key, request.service);
  key = await hmac("SHA-256", key, request.terminator);
  const signature = hex(await hmac("SHA-256", key, stringToSign));
  return `${request.algorithm} Credential=${request.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

/** 20150830T123600Z */
export function amzDate(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/** Alibaba Cloud RPC signature over the request's parameters. */
export async function aliyunSignature(
  method: string,
  params: Record<string, string>,
  secret: string,
): Promise<string> {
  const query = Object.keys(params)
    .sort()
    .map((key) => `${percentEncode(key)}=${percentEncode(params[key])}`)
    .join("&");
  const stringToSign = `${method}&${percentEncode("/")}&${percentEncode(query)}`;
  return base64(await hmac("SHA-1", `${secret}&`, stringToSign));
}
