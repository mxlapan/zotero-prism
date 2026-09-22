/**
 * Layout-preserving translation through an external service.
 *
 * Prism's own overlay keeps the original PDF and paints over it. When you want
 * a genuinely re-typeset bilingual PDF, hand the file to a service that does
 * document reconstruction — pdf2zh, MinerU or Doc2X — and Prism attaches the
 * result back onto the item.
 *
 * Endpoints are configurable because these services move fast; the adapters
 * below encode the request shape each one documented at the time of writing.
 */

import { config } from "../../../package.json";
import { sleep } from "../../utils/window";
import { bi } from "../../utils/locale";
import { getPref } from "../../utils/prefs";
import { request } from "../../utils/http";
import { bestAttachment, toRegularItem } from "../../utils/item";
import { openProgress } from "../../utils/progress";

export type ServiceType = "pdf2zh" | "mineru" | "doc2x" | "custom";

interface ServiceResult {
  /** local path of the translated file */
  path: string;
  filename: string;
}

function endpoint(): string {
  return getPref<string>("refract.layoutService", "").replace(/\/+$/, "");
}

function serviceKey(): string {
  return getPref<string>("refract.layoutServiceKey", "");
}

function serviceType(): ServiceType {
  return getPref<ServiceType>("refract.layoutServiceType", "pdf2zh");
}

export function serviceConfigured(): boolean {
  const type = serviceType();
  if (type === "pdf2zh") return !!endpoint();
  return !!endpoint() && !!serviceKey();
}

async function uploadMultipart(
  url: string,
  filePath: string,
  fields: Record<string, string>,
  headers: Record<string, string> = {},
): Promise<string> {
  const bytes = await IOUtils.read(filePath);
  const boundary = `----prism${Math.random().toString(36).slice(2)}`;
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(
      encoder.encode(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ),
    );
  }
  chunks.push(
    encoder.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${PathUtils.filename(
        filePath,
      )}"\r\nContent-Type: application/pdf\r\n\r\n`,
    ),
  );
  chunks.push(bytes);
  chunks.push(encoder.encode(`\r\n--${boundary}--\r\n`));

  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }

  const xhr = await Zotero.HTTP.request("POST", url, {
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}`, ...headers },
    body: body as any,
    responseType: "text",
    timeout: 300_000,
  } as any);
  return (xhr.response as string) || xhr.responseText || "";
}

async function download(url: string, filename: string): Promise<ServiceResult> {
  const dir = PathUtils.join(Zotero.DataDirectory.dir, "prism", "translated");
  await IOUtils.makeDirectory(dir, { ignoreExisting: true, createAncestors: true });
  const path = PathUtils.join(dir, filename);
  const xhr = await Zotero.HTTP.request("GET", url, {
    responseType: "arraybuffer",
    timeout: 300_000,
  } as any);
  await IOUtils.write(path, new Uint8Array(xhr.response as ArrayBuffer));
  return { path, filename };
}

async function poll<T>(
  fn: () => Promise<T | null>,
  intervalMS: number,
  timeoutMS: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMS;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await sleep(intervalMS);
  }
  throw new Error(bi("The service timed out.", "服务响应超时。"));
}

async function runPDF2ZH(filePath: string, lang: string): Promise<ServiceResult> {
  const base = endpoint() || "http://127.0.0.1:11008";
  const created = JSON.parse(
    await uploadMultipart(`${base}/v1/translate`, filePath, {
      lang_in: "en",
      lang_out: lang,
      service: "google",
    }),
  );
  const id = created.id || created.task_id;
  if (!id) throw new Error("pdf2zh did not return a task id");
  const done = await poll(
    async () => {
      const { text } = await request("GET", `${base}/v1/translate/${id}`, {
        timeout: 30000,
      });
      const status = JSON.parse(text);
      if (status.state === "SUCCESS" || status.status === "done") return status;
      if (status.state === "FAILURE") throw new Error(status.info || "pdf2zh failed");
      return null;
    },
    3000,
    900_000,
  );
  const url = done.url || `${base}/v1/translate/${id}/mono`;
  return download(url, `pdf2zh-${PathUtils.filename(filePath)}`);
}

async function runMinerU(filePath: string, lang: string): Promise<ServiceResult> {
  const base = endpoint() || "https://mineru.net";
  const headers = { Authorization: `Bearer ${serviceKey()}` };
  const created = JSON.parse(
    await uploadMultipart(
      `${base}/api/v4/extract/task`,
      filePath,
      { is_ocr: "true", enable_formula: "true", language: lang },
      headers,
    ),
  );
  const id = created?.data?.task_id || created?.task_id;
  if (!id) throw new Error(created?.msg || "MinerU did not return a task id");
  const done = await poll(
    async () => {
      const { text } = await request("GET", `${base}/api/v4/extract/task/${id}`, {
        headers,
        timeout: 30000,
      });
      const status = JSON.parse(text)?.data;
      if (status?.state === "done") return status;
      if (status?.state === "failed") throw new Error(status?.err_msg || "MinerU failed");
      return null;
    },
    4000,
    900_000,
  );
  const url = done.full_zip_url || done.zip_url;
  if (!url) throw new Error(bi("MinerU returned no download URL", "MinerU 未返回下载地址"));
  return download(url, `mineru-${PathUtils.filename(filePath).replace(/\.pdf$/i, "")}.zip`);
}

async function runDoc2X(filePath: string, _lang: string): Promise<ServiceResult> {
  const base = endpoint() || "https://v2.doc2x.noedgeai.com";
  const headers = { Authorization: `Bearer ${serviceKey()}` };
  const created = JSON.parse(
    await uploadMultipart(`${base}/api/v2/parse/pdf`, filePath, {}, headers),
  );
  const uid = created?.data?.uid;
  if (!uid) throw new Error(created?.msg || "Doc2X did not return a uid");
  const done = await poll(
    async () => {
      const { text } = await request(
        "GET",
        `${base}/api/v2/parse/status?uid=${uid}`,
        { headers, timeout: 30000 },
      );
      const status = JSON.parse(text)?.data;
      if (status?.status === "success") return status;
      if (status?.status === "failed") throw new Error(bi("Doc2X failed", "Doc2X 处理失败"));
      return null;
    },
    4000,
    900_000,
  );
  const url = done?.result?.pages?.[0]?.url || done?.url;
  if (!url) throw new Error(bi("Doc2X returned no download URL", "Doc2X 未返回下载地址"));
  return download(url, `doc2x-${PathUtils.filename(filePath)}`);
}

/** Send an item's PDF through the configured service and attach the result. */
export async function translateViaService(item: Zotero.Item) {
  const target = toRegularItem(item);
  if (!target) return;
  const attachment = await bestAttachment(target);
  const filePath = attachment ? await attachment.getFilePathAsync() : "";
  if (!filePath) {
    throw new Error(bi("No local PDF file found.", "未找到本地 PDF 文件。"));
  }
  const lang = getPref<string>("refract.targetLang", "zh-CN").startsWith("zh")
    ? "zh"
    : getPref<string>("refract.targetLang", "en");

  const progress = openProgress(
    `${bi("Sending to", "正在发送至")} ${serviceType()}…`,
    { progress: 10 },
  );

  try {
    const type = serviceType();
    const result =
      type === "mineru"
        ? await runMinerU(filePath, lang)
        : type === "doc2x"
          ? await runDoc2X(filePath, lang)
          : await runPDF2ZH(filePath, lang);

    const attachment = await Zotero.Attachments.importFromFile({
      file: result.path,
      parentItemID: target.id,
      title: `${bi("Translated", "译文")} — ${result.filename}`,
    });
    progress.changeLine({
      text: bi("Translated file attached", "译文已附加到条目"),
      progress: 100,
      type: "success",
    });
    // show the result rather than leave it under the item
    void Zotero.Reader.open(attachment.id);
  } catch (e: any) {
    progress.changeLine({ text: `${bi("Failed: ", "失败：")}${e?.message || e}`, type: "fail" });
  }
  progress.startCloseTimer(5000);
}
