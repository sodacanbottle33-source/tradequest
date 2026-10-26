// The AI teacher's connection (docs/world.md §19.4). It is OFF unless the owner sets TQ_AI_KEY in the server's settings (on Render: an
// Environment Variable). The key lives only in the server's memory: it is never written to the database, the log or any answer, and the browser
// never sees it. Two kinds of service are understood:
//   • "anthropic": the Claude Messages API (https://api.anthropic.com).
//   • "openai":    any service that speaks the OpenAI chat format (OpenAI, and many others with a free or cheap plan); give TQ_AI_BASE_URL and TQ_AI_MODEL.
// The AI only ever receives text the game wrote (the facts of a graded lesson plus the player's short "why", inside a tag) and can only give text back:
// it has no tools, no access to accounts, money or the database, and its text is cut to a few hundred characters and shown as plain text.

export type AiProvider = 'anthropic' | 'openai';

export interface AiSettings {
  readonly provider: AiProvider;
  /** Never enumerable, so it cannot end up in a JSON dump or a log line by accident. */
  readonly apiKey: string;
  readonly model: string;
  readonly baseUrl: string;
  /** How many comments one player can ask for per day, and how many everybody together. */
  readonly perUserDaily: number;
  readonly globalDaily: number;
  readonly timeoutMs: number;
  readonly maxTokens: number;
}

export type AiErrorKind = 'timeout' | 'network' | 'http' | 'bad_response';

export class AiError extends Error {
  constructor(
    readonly kind: AiErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface AiClient {
  /** One question, one answer, as plain text. Throws AiError. */
  complete(system: string, user: string): Promise<string>;
}

export const DEFAULT_ANTHROPIC_MODEL = 'claude-haiku-5-5';
export const DEFAULT_PER_USER_DAILY = 15;
export const DEFAULT_GLOBAL_DAILY = 300;
export const AI_TIMEOUT_MS = 12_000;
export const AI_MAX_TOKENS = 350;

function int(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be a whole number from ${min} to ${max}, got "${raw}"`);
  return n;
}

/** An address the server may send the key to: https anywhere, or plain http only to this very computer (tests, a local model). */
export function safeBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`TQ_AI_BASE_URL is not an address: "${raw}"`);
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new Error('TQ_AI_BASE_URL must start with https:// (plain http:// is only allowed for localhost).');
  if (url.username !== '' || url.password !== '') throw new Error('TQ_AI_BASE_URL must not contain a name or a password.');
  return raw.replace(/\/+$/, '');
}

/** The AI settings from the environment, or null when the AI is off (no TQ_AI_KEY). A wrong setting is an error with a plain explanation. */
export function loadAiSettings(env: NodeJS.ProcessEnv = process.env): AiSettings | null {
  const key = (env.TQ_AI_KEY ?? '').trim();
  if (key === '') return null;
  const provider = (env.TQ_AI_PROVIDER ?? 'anthropic').trim().toLowerCase();
  if (provider !== 'anthropic' && provider !== 'openai') throw new Error(`TQ_AI_PROVIDER must be anthropic or openai, got "${provider}"`);
  const model = (env.TQ_AI_MODEL ?? '').trim() || (provider === 'anthropic' ? DEFAULT_ANTHROPIC_MODEL : '');
  if (model === '') throw new Error('TQ_AI_MODEL is needed when TQ_AI_PROVIDER is openai (the name of the model your service offers).');
  const defaultBase = provider === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1';
  const baseUrl = safeBaseUrl((env.TQ_AI_BASE_URL ?? '').trim() || defaultBase);
  const settings = {
    provider: provider as AiProvider,
    model,
    baseUrl,
    perUserDaily: int(env, 'TQ_AI_PER_USER_DAILY', DEFAULT_PER_USER_DAILY, 1, 1000),
    globalDaily: int(env, 'TQ_AI_GLOBAL_DAILY', DEFAULT_GLOBAL_DAILY, 1, 1_000_000),
    timeoutMs: AI_TIMEOUT_MS,
    maxTokens: AI_MAX_TOKENS,
  };
  Object.defineProperty(settings, 'apiKey', { value: key, enumerable: false });
  return settings as AiSettings;
}

interface ClientOptions {
  readonly fetch?: typeof fetch;
}

async function readText(res: Response): Promise<string> {
  const text = await res.text();
  return text.length > 200_000 ? text.slice(0, 200_000) : text;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new AiError('bad_response', 'The AI service did not answer with JSON.');
  }
}

function textOfAnthropic(json: unknown): string {
  const content = (json as { content?: unknown })?.content;
  if (!Array.isArray(content)) throw new AiError('bad_response', 'The AI service answer has no text.');
  const parts: string[] = [];
  for (const c of content) {
    if (c && typeof c === 'object' && (c as { type?: unknown }).type === 'text' && typeof (c as { text?: unknown }).text === 'string') parts.push((c as { text: string }).text);
  }
  const text = parts.join('\n').trim();
  if (text === '') throw new AiError('bad_response', 'The AI service answer is empty.');
  return text;
}

function textOfOpenAi(json: unknown): string {
  const choices = (json as { choices?: unknown })?.choices;
  const first = Array.isArray(choices) ? (choices[0] as { message?: { content?: unknown } } | undefined) : undefined;
  const content = first?.message?.content;
  if (typeof content !== 'string' || content.trim() === '') throw new AiError('bad_response', 'The AI service answer is empty.');
  return content.trim();
}

export function createAiClient(settings: AiSettings, options: ClientOptions = {}): AiClient {
  const doFetch = options.fetch ?? fetch;

  async function post(url: string, headers: Record<string, string>, body: unknown): Promise<{ status: number; text: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), settings.timeoutMs);
    try {
      const res = await doFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: controller.signal });
      return { status: res.status, text: await readText(res) };
    } catch (error) {
      if (controller.signal.aborted) throw new AiError('timeout', 'The AI service took too long to answer.');
      throw new AiError('network', error instanceof Error && error.name === 'AbortError' ? 'The AI request was stopped.' : 'The AI service could not be reached.');
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async complete(system, user) {
      if (settings.provider === 'anthropic') {
        const out = await post(
          `${settings.baseUrl}/v1/messages`,
          { 'x-api-key': settings.apiKey, 'anthropic-version': '2023-06-01' },
          { model: settings.model, max_tokens: settings.maxTokens, system, messages: [{ role: 'user', content: user }] },
        );
        if (out.status < 200 || out.status >= 300) throw new AiError('http', `The AI service answered ${out.status}.`, out.status);
        return textOfAnthropic(parseJson(out.text));
      }
      const url = `${settings.baseUrl}/chat/completions`;
      const headers = { Authorization: `Bearer ${settings.apiKey}` };
      const messages = [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ];
      let out = await post(url, headers, { model: settings.model, max_tokens: settings.maxTokens, messages });
      // Some newer models only accept the other name for the limit; try once with it.
      if (out.status === 400 && out.text.includes('max_completion_tokens')) {
        out = await post(url, headers, { model: settings.model, max_completion_tokens: settings.maxTokens, messages });
      }
      if (out.status < 200 || out.status >= 300) throw new AiError('http', `The AI service answered ${out.status}.`, out.status);
      return textOfOpenAi(parseJson(out.text));
    },
  };
}
