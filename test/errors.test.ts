import { classifyHTTP, explainRequestFailure, HTTPError, NetworkError } from "../src/utils/http";

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

console.log(fails.length ? `\n${fails.length} FAILURES` : "\nall green");
process.exit(fails.length ? 1 : 0);
