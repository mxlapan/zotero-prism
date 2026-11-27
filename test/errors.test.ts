import { classifyHTTP, explainRequestFailure, HTTPError, NetworkError } from "../src/utils/http";
import { engineByID, deeplTarget, ENGINES, translateBatch } from "../src/modules/refract/engines";

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

  ok("deepl: Traditional Chinese is named", deeplTarget("zh-TW") === "ZH-HANT");
  ok("deepl: Simplified Chinese is named", deeplTarget("zh-CN") === "ZH-HANS");

  console.log(fails.length ? `\n${fails.length} FAILURES` : "\nall green");
  process.exit(fails.length ? 1 : 0);
})();
