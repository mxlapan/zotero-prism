/** Conversation state shared by the floating panel, the reader sidebar and the note pane. */

import { AbortLike, errorText } from "../../utils/http";
import { getPref } from "../../utils/prefs";
import { chat, currentProfile, type ChatMessage } from "./provider";
import {
  FORMULAS,
  matchTrigger,
  renderPrompt,
  type PromptDef,
  type PromptEnv,
} from "./prompts";
import { searchLibrary } from "./rag";
import { estimateTokens } from "../../utils/text";

export interface SourceRef {
  title: string;
  page: number;
  itemKey: string;
  score: number;
  text: string;
}

export interface Turn {
  role: "user" | "assistant";
  content: string;
  /** what was actually sent, when it differs from what the user typed */
  expanded?: string;
  images?: string[];
  sources?: SourceRef[];
  model?: string;
  promptID?: string;
  ms?: number;
  error?: boolean;
  ts: number;
}

export interface SendOptions {
  prompt?: PromptDef;
  env?: PromptEnv;
  onUpdate?: (turn: Turn, session: ChatSession) => void;
  /** skip conversation history — used by one-shot actions */
  oneShot?: boolean;
  transport?: "auto" | "api" | "bridge";
}

export class ChatSession {
  readonly id: string;
  turns: Turn[] = [];
  busy = false;
  private controller?: AbortLike;
  title = "";

  constructor(id: string) {
    this.id = id;
  }

  reset() {
    this.stop();
    this.turns = [];
    this.title = "";
  }

  stop() {
    this.controller?.abort();
    this.controller = undefined;
    this.busy = false;
  }

  /**
   * Messages handed to the provider, trimmed to a sane context budget.
   * The last turn is the empty assistant placeholder we are about to fill, so
   * it never travels with the request.
   */
  private history(systemPrompt: string, oneShot: boolean): ChatMessage[] {
    const messages: ChatMessage[] = [];
    if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
    const sent = this.turns.slice(0, -1);
    const source = oneShot ? sent.slice(-1) : sent;
    const budget = 90_000;
    const picked: Turn[] = [];
    let used = 0;
    for (let i = source.length - 1; i >= 0; i--) {
      const turn = source[i];
      const cost = estimateTokens(turn.expanded || turn.content);
      if (used + cost > budget && picked.length) break;
      used += cost;
      picked.unshift(turn);
    }
    for (const turn of picked) {
      const content = turn.expanded || turn.content;
      if (!content.trim()) continue;
      messages.push({ role: turn.role, content, images: turn.images });
    }
    return messages;
  }

  async send(input: string, options: SendOptions = {}): Promise<Turn> {
    if (this.busy) this.stop();
    const started = Date.now();
    const controller = new AbortLike();
    this.controller = controller;
    this.busy = true;

    const typed = input.trim();
    const prompt = options.prompt || matchTrigger(typed);
    const env: PromptEnv = {
      question: prompt && typed.startsWith("/") ? stripCommand(typed) : typed,
      ...options.env,
    };
    if (!env.question && options.env?.question) env.question = options.env.question;

    let expanded = env.question || typed;
    let images: string[] = env.images || [];
    let sources: SourceRef[] = [];

    try {
      if (prompt) {
        const rendered = await renderPrompt(prompt, env);
        expanded = rendered.text;
        images = rendered.images;
        if (prompt.context === "library") {
          sources = await collectSources(env.question || typed);
        }
      }
    } catch (e) {
      Zotero.debug(`[Prism] prompt expansion failed: ${e}`);
    }

    const userTurn: Turn = {
      role: "user",
      content: typed || prompt?.name || "",
      expanded,
      images,
      promptID: prompt?.id,
      ts: started,
    };
    this.turns.push(userTurn);
    if (!this.title) this.title = (typed || prompt?.name || "").slice(0, 60);

    const answerTurn: Turn = {
      role: "assistant",
      content: "",
      sources,
      model: currentProfile().model,
      promptID: prompt?.id,
      ts: Date.now(),
    };
    this.turns.push(answerTurn);
    // A repaint that throws must not reach the stream: it would drop the rest
    // of that network chunk from the answer, and from `finally` it would leave
    // the caller hanging with the session half-finished.
    const notify = () => {
      try {
        options.onUpdate?.(answerTurn, this);
      } catch (e) {
        Zotero.debug(`[Prism] chat repaint failed: ${e}`);
      }
    };
    notify();

    try {
      // the user's system prompt, plus the one rule the renderer depends on
      const system = [getPref<string>("lens.systemPrompt", ""), FORMULAS].filter(Boolean).join("\n\n");
      const messages = this.history(system, !!options.oneShot);
      const text = await chat(messages, {
        signal: controller,
        transport: options.transport,
        onToken: (_delta, whole) => {
          answerTurn.content = whole;
          notify();
        },
      });
      answerTurn.content = text;
      answerTurn.ms = Date.now() - started;
    } catch (e: any) {
      answerTurn.error = true;
      answerTurn.content =
        e?.code === "PRISM_NO_KEY"
          ? noKeyMessage()
          : `**Request failed**\n\n${errorText(e)}`;
      answerTurn.ms = Date.now() - started;
    } finally {
      this.busy = false;
      this.controller = undefined;
      notify();
    }
    return answerTurn;
  }
}

function stripCommand(text: string): string {
  return text.replace(/^[/#]\S+\s*/, "").trim();
}

function noKeyMessage(): string {
  return [
    "**No model is configured yet.**",
    "",
    "Two ways to fix it:",
    "",
    "1. *Settings → Prism → AI* — paste a base URL, API key and model name. Anything speaking the OpenAI or Anthropic protocol works (OpenAI, DeepSeek, SiliconFlow, Moonshot, Zhipu, Ollama, LM Studio, a relay…).",
    "2. *Web chat linkage* — install the Prism browser add-on from the settings pane, open a chat site you already pay for, and press Connect. No key needed.",
  ].join("\n");
}

async function collectSources(query: string): Promise<SourceRef[]> {
  try {
    const hits = await searchLibrary(query, {
      topK: Number(getPref("lens.topK", 8)),
    });
    return hits.map((hit) => ({
      title: hit.title,
      page: hit.page,
      itemKey: hit.itemKey,
      score: hit.score,
      text: hit.text.slice(0, 400),
    }));
  } catch {
    return [];
  }
}

export function sessionFor(key: string): ChatSession {
  const sessions = addon.data.lens.sessions;
  let session = sessions.get(key);
  if (!session) {
    session = new ChatSession(key);
    sessions.set(key, session);
  }
  return session;
}

export function dropSession(key: string) {
  addon.data.lens.sessions.get(key)?.stop();
  addon.data.lens.sessions.delete(key);
}
