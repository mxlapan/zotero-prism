import { classifyHTTP, explainRequestFailure, HTTPError, NetworkError } from "../src/utils/http";
import { engineByID, deeplTarget, ENGINES, translateBatch } from "../src/modules/refract/engines";
import { aliyunSignature, signV4 } from "../src/modules/refract/signing";

const fails: string[] = [];
const ok = (n: string, c: boolean, extra = "") => { if (!c) fails.push(n); console.log(`${c ? "PASS" : "FAIL"}  ${n} ${extra}`); };
const is = (name: string, status: number, body: string, kind: string) => {
  const got = classifyHTTP(status, body);
  ok(name, got === kind, `-> ${got}`);
};

// bodies as the providers send them
is("OpenAI bad key", 401, `{"error":{"message":"Incorrect API key provided: sk-abc","type":"invalid_request_error","code":"invalid_api_key"}}`, "auth");
is("OpenAI unknown model", 404, `{"error":{"message":"The model \`gpt-9\` does not exist or you do not have access to it.","code":"model_not_found"}}`, "model");
is("DeepSeek unknown model", 400, `{"error":{"message":"Model Not Exist","type":"invalid_request_error"}}`, "model");
is("DeepSeek no balance", 402, `{"error":{"message":"Insufficient Balance","type":"unknown_error"}}`, "quota");
is("OpenAI quota", 429, `{"error":{"message":"You exceeded your current quota, please check your plan and billing details.","code":"insufficient_quota"}}`, "quota");
is("plain rate limit", 429, `{"error":{"message":"Rate limit reached for requests"}}`, "rate");
is("Anthropic unknown model", 404, `{"type":"error","error":{"type":"not_found_error","message":"model: claude-x"}}`, "model");
is("Anthropic context", 400, `{"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 210000 tokens > 200000 maximum"}}`, "context");
is("OpenAI context", 400, `{"error":{"message":"This model's maximum context length is 128000 tokens."}}`, "context");
is("Chinese gateway key", 401, `{"code":401,"msg":"无效的令牌"}`, "auth");
is("wrong path", 404, `<html><body>Not Found</body></html>`, "address");
is("server down", 502, `<html>Bad Gateway</html>`, "server");
is("DeepL forbidden", 403, `{"message":"Wrong endpoint. Use https://api.deepl.com"}`, "auth");

const status0 = explainRequestFailure({ name: "UnexpectedStatusException", xmlhttp: { status: 0, responseText: "" } }, "http://127.0.0.1:11434/v1/chat/completions");
ok("status 0 reads as unreachable", status0 instanceof NetworkError && (status0 as NetworkError).kind === "unreachable", status0.message);
ok("host named in the message", status0.message.startsWith("127.0.0.1:11434"), status0.message);
const timeout = explainRequestFailure({ name: "TimeoutException", message: "XMLHttpRequest has timed out after 60000ms" }, "https://api.x.com/v1");
ok("timeout", (timeout as NetworkError).kind === "timeout", timeout.message);
const http = explainRequestFailure({ xmlhttp: { status: 401, responseText: `{"error":{"message":"bad key"}}` } }, "https://api.x.com/v1");
ok("HTTP error keeps its status for the engines", http instanceof HTTPError && /HTTP 401/.test(http.message), http.message);

is("DeepL quota used up", 456, `{"message":"Quota exceeded"}`, "quota");

/* DeepL rejects a key sent as `auth_key` in the body since 15 January 2026; the
   same key kept working in other plugins, which send it as a header.
   The runner waits on `__testsDone` before moving on. */
(globalThis as any).__testsDone = (async () => {
  const sent: any[] = [];
  const zotero = (globalThis as any).Zotero;
  const previous = zotero.HTTP;
  zotero.HTTP = {
    request: async (method: string, url: string, options: any) => {
      sent.push({ method, url, ...options });
      return { status: 200, responseText: `{"translations":[{"text":"结果见表 2。"}]}` };
    },
  };
  try {
    const out = await engineByID("deepl").translate(["The results are shown in Table 2."], {
      from: "auto",
      to: "zh-CN",
      keys: { authKey: "abc-123:fx" },
    });
    const call = sent[0] || {};
    ok("deepl: key goes in the Authorization header", call.headers?.Authorization === "DeepL-Auth-Key abc-123:fx", JSON.stringify(call.headers));
    ok("deepl: key is not in the body", !String(call.body || "").includes("auth_key") && !String(call.body || "").includes("abc-123"), String(call.body));
    ok("deepl: free key uses the free host", String(call.url).startsWith("https://api-free.deepl.com/"), call.url);
    ok("deepl: translation read back", out[0] === "结果见表 2。", JSON.stringify(out));
  } catch (e) {
    ok("deepl: request can be built", false, String(e));
  } finally {
    zotero.HTTP = previous;
  }
  /* GitHub #3: with the chosen engine out of reach, every paragraph came from
     the fallback, was cached under the fallback, and was translated over the
     network again on every run because only the chosen engine's cache was read. */
  {
    const g = globalThis as any;
    g.addon.data.refract = { cache: new Map() };
    const getMainWindow = g.Zotero.getMainWindow;
    g.Zotero.getMainWindow = () => null;
    const calls = { dead: 0, live: 0 };
    const dead = {
      id: "test-dead",
      label: "Dead",
      batch: 1,
      translate: async () => {
        calls.dead++;
        throw Object.assign(new Error("connection refused"), { kind: "unreachable" });
      },
    };
    const live = {
      id: "test-live",
      label: "Live",
      batch: 1,
      translate: async (texts: string[]) => {
        calls.live += texts.length;
        return texts.map((text) => `译：${text}`);
      },
    };
    const engines = ENGINES.splice(0, ENGINES.length, dead as any, live as any);
    try {
      const first = await translateBatch(["alpha", "beta"], { engine: "test-dead", to: "zh-CN" });
      ok("fallback translates when the chosen engine is unreachable", first.join("|") === "译：alpha|译：beta", JSON.stringify(first));
      const network = { ...calls };
      const second = await translateBatch(["alpha", "beta"], { engine: "test-dead", to: "zh-CN" });
      ok("the second run is answered from the fallback's cache", second.join("|") === "译：alpha|译：beta" && calls.live === network.live, `${JSON.stringify(second)} live calls ${network.live} -> ${calls.live}`);
      ok("an unreachable engine is not asked again straight away", calls.dead === network.dead, `dead calls ${network.dead} -> ${calls.dead}`);
      const third = await translateBatch(["alpha", "gamma"], { engine: "test-dead", to: "zh-CN" });
      ok("only the new paragraph goes over the network", third.join("|") === "译：alpha|译：gamma" && calls.live === network.live + 1, `${JSON.stringify(third)} live calls ${calls.live}`);
    } catch (e) {
      ok("fallback cache scenario runs", false, String(e));
    } finally {
      ENGINES.splice(0, ENGINES.length, ...engines);
      g.Zotero.getMainWindow = getMainWindow;
    }
  }

  /* Signing, checked against the providers' published examples. */
  {
    const aws = await signV4({
      algorithm: "AWS4-HMAC-SHA256", secretPrefix: "AWS4", terminator: "aws4_request", regionInScope: true,
      accessKey: "AKIDEXAMPLE", secretKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
      region: "us-east-1", service: "iam", method: "GET", path: "/",
      query: { Action: "ListUsers", Version: "2010-05-08" },
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=utf-8", Host: "iam.amazonaws.com", "X-Amz-Date": "20150830T123600Z" },
      payload: "", date: "20150830", stamp: "20150830T123600Z",
    });
    ok("SigV4 matches AWS's worked example", aws.endsWith("Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7"), aws);
    const aliyun = await aliyunSignature("GET", {
      AccessKeyId: "testid", Action: "DescribeRegions", Format: "XML", SignatureMethod: "HMAC-SHA1",
      SignatureNonce: "3ee8c1b8-83d3-44af-a94f-4e0ad82fd6cf", SignatureVersion: "1.0",
      Timestamp: "2016-02-23T12:46:24Z", Version: "2014-05-26",
    }, "testsecret");
    ok("Alibaba Cloud RPC signature matches its worked example", aliyun === "OLeaidS1JvxuMvnyHOwuJ+uX5qY=", aliyun);
  }

  /* Each new engine's request, as sent, against a canned reply. */
  {
    const zotero = (globalThis as any).Zotero;
    const previousHTTP = zotero.HTTP;
    const previousUtilities = zotero.Utilities;
    const calls: any[] = [];
    const replies: Array<[RegExp, (call: any) => string]> = [
      [/volcengine\.com\/crx/, () => `{"translation":"结果见表 2。","base_resp":{"status_code":0}}`],
      [/translation\.googleapis/, (c) => JSON.stringify({ data: { translations: JSON.parse(c.body).q.map(() => ({ translatedText: "译" })) } })],
      [/tmt\.tencentcloudapi/, () => `{"Response":{"TargetText":"结果见表 2。","RequestId":"x"}}`],
      [/mt\.cn-hangzhou\.aliyuncs/, () => `{"Code":"200","Data":{"Translated":"结果见表 2。"}}`],
      [/translate\.volcengineapi/, (c) => JSON.stringify({ TranslationList: JSON.parse(c.body).TextList.map(() => ({ Translation: "译" })) })],
      [/interpreter\.caiyunai/, (c) => JSON.stringify({ target: JSON.parse(c.body).source.map(() => "译"), rc: 0 })],
      [/amazonaws\.com/, () => `{"TranslatedText":"结果见表 2。"}`],
      [/translate\.api\.cloud\.yandex/, (c) => JSON.stringify({ translations: JSON.parse(c.body).texts.map(() => ({ text: "译" })) })],
      [/mymemory/, () => `{"responseData":{"translatedText":"译。"},"responseStatus":200,"quotaFinished":false}`],
      [/microsofttranslator/, () => `[{"translations":[{"text":"译"}]}]`],
      [/fanyi-api\.baidu/, () => `{"trans_result":[{"dst":"译"}]}`],
    ];
    zotero.HTTP = {
      request: async (method: string, url: string, options: any) => {
        const call = { method, url, ...options };
        calls.push(call);
        const reply = replies.find(([pattern]) => pattern.test(url));
        return { status: 200, responseText: reply ? reply[1](call) : "{}" };
      },
    };
    zotero.Utilities = { Internal: { md5: (text: string) => "0".repeat(31) + String(text.length % 10) } };
    const run = async (id: string, keys: Record<string, string>, texts: string[], to = "zh-CN") => {
      calls.length = 0;
      const out = await engineByID(id).translate(texts, { from: "auto", to, keys });
      return { out, calls: [...calls] };
    };
    const sample = "The results are shown in Table 2.";
    try {
      let r = await run("volcano", {}, [sample]);
      ok("volcano: detects the source and returns the translation", JSON.parse(r.calls[0].body).source_language === "detect" && r.out[0] === "结果见表 2。", r.calls[0].body);
      r = await run("volcano", {}, [sample], "zh-TW");
      ok("volcano: Traditional Chinese is zh-Hant", JSON.parse(r.calls[0].body).target_language === "zh-Hant");

      r = await run("googlecloud", { apiKey: "AIzaTEST" }, [sample, "Second."]);
      ok("googlecloud: one request for a batch, key in the URL", r.calls.length === 1 && r.calls[0].url.includes("key=AIzaTEST") && JSON.parse(r.calls[0].body).q.length === 2 && r.out.length === 2);

      r = await run("tencent", { secretId: "AKIDtest", secretKey: "secret" }, [sample]);
      const tc = r.calls[0];
      ok("tencent: TC3 signature over content-type and host", /^TC3-HMAC-SHA256 Credential=AKIDtest\/\d{4}-\d{2}-\d{2}\/tmt\/tc3_request, SignedHeaders=content-type;host, Signature=[0-9a-f]{64}$/.test(tc.headers.Authorization), tc.headers.Authorization);
      ok("tencent: action, version and default region", tc.headers["X-TC-Action"] === "TextTranslate" && tc.headers["X-TC-Version"] === "2018-03-21" && tc.headers["X-TC-Region"] === "ap-beijing");
      ok("tencent: languages and text in the body", JSON.parse(tc.body).Target === "zh" && JSON.parse(tc.body).Source === "auto" && r.out[0] === "结果见表 2。");

      r = await run("aliyun", { accessKeyId: "LTAItest", accessKeySecret: "secret" }, [sample]);
      const form = new URLSearchParams(r.calls[0].body);
      ok("aliyun: signed TranslateGeneral request", form.get("Action") === "TranslateGeneral" && /^[A-Za-z0-9+/]+=*$/.test(form.get("Signature") || "") && form.get("TargetLanguage") === "zh" && form.get("SourceText") === sample, r.calls[0].body.slice(0, 200));
      ok("aliyun: translation read back", r.out[0] === "结果见表 2。");

      r = await run("volcengine", { accessKeyId: "AKLTtest", secretAccessKey: "secret" }, Array.from({ length: 20 }, () => sample));
      const ve = r.calls[0];
      ok("volcengine: signed with the cn-north-1/translate scope", /^HMAC-SHA256 Credential=AKLTtest\/\d{8}\/cn-north-1\/translate\/request, SignedHeaders=content-type;host;x-content-sha256;x-date, Signature=[0-9a-f]{64}$/.test(ve.headers.Authorization), ve.headers.Authorization);
      ok("volcengine: no more than 16 texts a request", r.calls.length === 2 && JSON.parse(r.calls[0].body).TextList.length === 16 && r.out.length === 20 && !("SourceLanguage" in JSON.parse(ve.body)));

      r = await run("caiyun", { token: "tok" }, [sample]);
      ok("caiyun: token header and auto2zh", r.calls[0].headers["x-authorization"] === "token tok" && JSON.parse(r.calls[0].body).trans_type === "auto2zh" && r.out[0] === "译");

      r = await run("amazon", { accessKeyId: "AKIAtest", secretAccessKey: "secret" }, [sample]);
      const am = r.calls[0];
      ok("amazon: SigV4 for translate in us-east-1", am.url === "https://translate.us-east-1.amazonaws.com/" && /^AWS4-HMAC-SHA256 Credential=AKIAtest\/\d{8}\/us-east-1\/translate\/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-target, Signature=[0-9a-f]{64}$/.test(am.headers.Authorization), am.headers.Authorization);
      ok("amazon: target and languages", am.headers["X-Amz-Target"] === "AWSShineFrontendService_20170701.TranslateText" && JSON.parse(am.body).TargetLanguageCode === "zh" && JSON.parse(am.body).SourceLanguageCode === "auto");

      r = await run("yandex", { apiKey: "ykey" }, [sample, "Second."]);
      ok("yandex: Api-Key header, batch in one request", r.calls[0].headers.Authorization === "Api-Key ykey" && JSON.parse(r.calls[0].body).texts.length === 2 && r.out.length === 2);

      r = await run("mymemory", {}, ["The first sentence is here. ".repeat(40)]);
      ok("mymemory: a long paragraph goes in pieces under 500 characters", r.calls.length > 1 && r.calls.every((c) => (new URL(c.url).searchParams.get("q") || "").length <= 450), String(r.calls.length));
      ok("mymemory: auto-detected source", new URL(r.calls[0].url).searchParams.get("langpair") === "autodetect|zh-CN");
      ok("mymemory: Chinese pieces joined without spaces", !r.out[0].includes(" "), r.out[0]);

      r = await run("microsoft", { key: "k" }, [sample]);
      ok("microsoft: Simplified Chinese is zh-Hans", r.calls[0].url.includes("to=zh-Hans"), r.calls[0].url);

      r = await run("baidu", { appid: "1", key: "k", domain: "academic" }, [sample]);
      ok("baidu: a domain uses field translation", r.calls[0].url.endsWith("/fieldtranslate") && new URLSearchParams(r.calls[0].body).get("domain") === "academic");
      r = await run("baidu", { appid: "1", key: "k" }, [sample]);
      ok("baidu: no domain stays on general translation", r.calls[0].url.endsWith("/translate") && !new URLSearchParams(r.calls[0].body).has("domain"));
    } catch (e) {
      ok("engine requests can be built", false, String((e as any)?.stack || e));
    } finally {
      zotero.HTTP = previousHTTP;
      zotero.Utilities = previousUtilities;
    }
  }

  ok("deepl: Traditional Chinese is named", deeplTarget("zh-TW") === "ZH-HANT");
  ok("deepl: Simplified Chinese is named", deeplTarget("zh-CN") === "ZH-HANS");

  console.log(fails.length ? `\n${fails.length} FAILURES` : "\nall green");
  process.exit(fails.length ? 1 : 0);
})();
