const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { lookup } = require("node:dns/promises");
const { isIP } = require("node:net");
const { DatabaseSync } = require("node:sqlite");

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const PORT = Number(process.env.PORT || 4173);
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 14;
const BODY_LIMIT = 1024 * 1024;
const COOKIE_NAME = "modeldesk_session";
fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

function loadEncryptionKey() {
  if (process.env.APP_SECRET_KEY) {
    const key = Buffer.from(process.env.APP_SECRET_KEY, "hex");
    if (key.length !== 32) throw new Error("APP_SECRET_KEY must be 64 hex characters.");
    return key;
  }
  const keyPath = path.join(DATA_DIR, "master.key");
  if (!fs.existsSync(keyPath)) fs.writeFileSync(keyPath, crypto.randomBytes(32), { mode: 0o600, flag: "wx" });
  return fs.readFileSync(keyPath);
}

const encryptionKey = loadEncryptionKey();
const db = new DatabaseSync(path.join(DATA_DIR, "modeldesk.sqlite"));
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    password_salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS connections (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    secret TEXT NOT NULL,
    metadata TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, provider)
  );
  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    provider TEXT,
    model TEXT,
    content TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ok',
    input_tokens INTEGER,
    output_tokens INTEGER,
    latency_ms INTEGER,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
  CREATE INDEX IF NOT EXISTS conversations_owner_updated ON conversations(user_id, updated_at DESC);
  CREATE INDEX IF NOT EXISTS messages_conversation_created ON messages(conversation_id, created_at);
`);

const COMPATIBLE = (name, mark, endpoint, models, placeholder = "API key") => ({ name, mark, protocol: "openai-compatible", endpoint, models, placeholder });
const PROVIDERS = {
  openai: COMPATIBLE("OpenAI", "O", "https://api.openai.com/v1/chat/completions", ["gpt-4.1", "gpt-4.1-mini", "o4-mini"], "sk-…"),
  anthropic: { name: "Anthropic (Claude)", mark: "A", protocol: "anthropic", models: ["claude-sonnet-4-20250514", "claude-3-7-sonnet-20250219"], placeholder: "sk-ant-…" },
  groq: COMPATIBLE("Groq", "G", "https://api.groq.com/openai/v1/chat/completions", ["openai/gpt-oss-120b", "openai/gpt-oss-20b", "meta-llama/llama-4-scout-17b-16e-instruct", "meta-llama/llama-4-maverick-17b-128e-instruct", "llama-3.3-70b-versatile"], "gsk_…"),
  xai: COMPATIBLE("xAI (Grok)", "X", "https://api.x.ai/v1/chat/completions", ["grok-3", "grok-3-mini"], "xai-…"),
  gemini: { name: "Google Gemini", mark: "G", protocol: "gemini", models: ["gemini-2.5-flash", "gemini-2.5-pro"], placeholder: "AIza…" },
  mistral: COMPATIBLE("Mistral AI", "M", "https://api.mistral.ai/v1/chat/completions", ["mistral-large-latest", "mistral-small-latest" ]),
  deepseek: COMPATIBLE("DeepSeek", "D", "https://api.deepseek.com/chat/completions", ["deepseek-chat", "deepseek-reasoner"], "sk-…"),
  openrouter: COMPATIBLE("OpenRouter", "R", "https://openrouter.ai/api/v1/chat/completions", ["openai/gpt-4.1", "anthropic/claude-sonnet-4", "deepseek/deepseek-r1"], "sk-or-…"),
  together: COMPATIBLE("Together AI", "T", "https://api.together.xyz/v1/chat/completions", ["meta-llama/Llama-3.3-70B-Instruct-Turbo", "Qwen/Qwen2.5-72B-Instruct-Turbo"]),
  fireworks: COMPATIBLE("Fireworks AI", "F", "https://api.fireworks.ai/inference/v1/chat/completions", ["accounts/fireworks/models/llama-v3p3-70b-instruct", "accounts/fireworks/models/qwen2p5-72b-instruct"], "fw_…"),
  cerebras: COMPATIBLE("Cerebras", "C", "https://api.cerebras.ai/v1/chat/completions", ["llama-3.3-70b", "qwen-3-32b"]),
  perplexity: COMPATIBLE("Perplexity", "P", "https://api.perplexity.ai/chat/completions", ["sonar-pro", "sonar"], "pplx-…"),
  sambanova: COMPATIBLE("SambaNova", "S", "https://api.sambanova.ai/v1/chat/completions", ["DeepSeek-R1", "Meta-Llama-3.3-70B-Instruct"]),
  nvidia: COMPATIBLE("NVIDIA NIM", "N", "https://integrate.api.nvidia.com/v1/chat/completions", ["meta/llama-3.3-70b-instruct", "deepseek-ai/deepseek-r1"], "nvapi-…"),
  deepinfra: COMPATIBLE("DeepInfra", "I", "https://api.deepinfra.com/v1/openai/chat/completions", ["meta-llama/Meta-Llama-3.1-70B-Instruct", "deepseek-ai/DeepSeek-R1"]),
  huggingface: COMPATIBLE("Hugging Face", "H", "https://router.huggingface.co/v1/chat/completions", ["meta-llama/Llama-3.3-70B-Instruct", "Qwen/Qwen2.5-72B-Instruct"], "hf_…"),
  cohere: { name: "Cohere", mark: "C", protocol: "cohere", models: ["command-a-03-2025", "command-r-plus-08-2024"], placeholder: "API key" },
  azure: { name: "Azure OpenAI", mark: "A", protocol: "azure", models: [], placeholder: "Azure API key", fields: ["endpoint", "deployment", "apiVersion"] },
  bedrock: { name: "AWS Bedrock", mark: "B", protocol: "bedrock", models: ["anthropic.claude-3-5-sonnet-20241022-v2:0", "amazon.nova-lite-v1:0"], placeholder: "AWS access key", fields: ["region", "accessKeyId", "secretAccessKey", "sessionToken"] },
  vertex: { name: "Google Vertex AI", mark: "V", protocol: "vertex", models: ["gemini-2.5-flash", "gemini-2.5-pro"], placeholder: "Service account JSON", fields: ["projectId", "region", "serviceAccountJson"] },
  replicate: { name: "Replicate", mark: "R", protocol: "replicate", models: ["meta/meta-llama-3-70b-instruct"], placeholder: "r8_…", fields: ["model"] },
  custom: { name: "Custom OpenAI-compatible", mark: "+", protocol: "custom", models: [], placeholder: "Optional API key", fields: ["endpoint", "model"] }
};

function json(res, status, value, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
  res.end(JSON.stringify(value));
}

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString("base64url")).join(".");
}

function decrypt(value) {
  const [iv, tag, ciphertext] = value.split(".").map((part) => Buffer.from(part, "base64url"));
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey, iv);
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8"));
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function passwordHash(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}
const DUMMY_SALT = "modeldesk-invalid-account-salt";
const DUMMY_PASSWORD_HASH = Buffer.from(passwordHash("modeldesk-invalid-account", DUMMY_SALT), "hex");

function createSession(userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  const expires = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  db.prepare("INSERT INTO sessions(token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(hashToken(token), userId, expires);
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_SECONDS}${secure}`.replace("session=", `${COOKIE_NAME}=`);
}

function cookieValue(req, name) {
  const cookies = (req.headers.cookie || "").split(";").map((item) => item.trim());
  const item = cookies.find((cookie) => cookie.startsWith(`${name}=`));
  return item ? decodeURIComponent(item.slice(name.length + 1)) : "";
}

function userFromRequest(req) {
  const token = cookieValue(req, COOKIE_NAME);
  if (!token) return null;
  return db.prepare(`SELECT users.id, users.email FROM sessions JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ?`).get(hashToken(token), Math.floor(Date.now() / 1000)) || null;
}

function requireUser(req) {
  const user = userFromRequest(req);
  if (!user) fail(401, "Sign in to continue.");
  return user;
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > BODY_LIMIT) fail(413, "Request body is too large.");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
  catch { fail(400, "Request body must be valid JSON."); }
}

function verifyOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return;
  try {
    if (new URL(origin).host !== req.headers.host) fail(403, "Cross-origin request rejected.");
  } catch { fail(403, "Cross-origin request rejected."); }
}

function safeMetadata(providerId, config) {
  const provider = PROVIDERS[providerId];
  return Object.fromEntries((provider.fields || []).filter((field) => !["serviceAccountJson", "secretAccessKey", "sessionToken", "accessKeyId"].includes(field)).map((field) => [field, config[field] || ""]));
}

function isPrivateAddress(address) {
  if (isIP(address) === 4) {
    const [first, second] = address.split(".").map(Number);
    return first === 0 || first === 10 || first === 127 || first >= 224 ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && (second === 0 || second === 168)) ||
      (first === 198 && (second === 18 || second === 19));
  }
  if (isIP(address) === 6) {
    const normalized = address.toLowerCase();
    if (normalized.startsWith("::ffff:")) return isPrivateAddress(normalized.slice(7));
    return normalized === "::" || normalized === "::1" || /^(fc|fd|fe[89ab])/.test(normalized) || normalized.startsWith("ff");
  }
  return true;
}

async function validateEndpoint(value, allowPrivate = false) {
  let endpoint;
  try { endpoint = new URL(value); } catch { fail(400, "Enter a valid endpoint URL."); }
  if (!["http:", "https:"].includes(endpoint.protocol)) fail(400, "Endpoint must use HTTP or HTTPS.");
  const hostname = endpoint.hostname.replace(/\.$/, "").toLowerCase();
  const privateHost = hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal");
  if (!allowPrivate) {
    const literalHost = hostname.replace(/^\[|\]$/g, "");
    if (privateHost || (isIP(literalHost) && isPrivateAddress(literalHost))) fail(400, "Private network endpoints require ALLOW_PRIVATE_ENDPOINTS=true.");
    let addresses;
    try { addresses = await lookup(hostname, { all: true, verbatim: true }); }
    catch { fail(400, "The custom endpoint host could not be resolved."); }
    if (!addresses.length || addresses.some((entry) => isPrivateAddress(entry.address))) fail(400, "Custom endpoints must resolve to public IP addresses.");
  }
  if (endpoint.protocol === "http:" && !allowPrivate) fail(400, "Public custom endpoints must use HTTPS.");
  endpoint.username = "";
  endpoint.password = "";
  endpoint.hash = "";
  return endpoint.toString().replace(/\/$/, "");
}

async function validateConnection(providerId, input) {
  if (!PROVIDERS[providerId]) fail(404, "Unknown provider.");
  const config = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const text = (name, max = 500) => typeof config[name] === "string" ? config[name].trim().slice(0, max) : "";
  if (providerId === "azure") {
    const endpoint = text("endpoint");
    let url;
    try { url = new URL(endpoint); } catch { fail(400, "Enter your Azure OpenAI resource endpoint."); }
    if (url.protocol !== "https:" || !(url.hostname.endsWith(".openai.azure.com") || url.hostname.endsWith(".services.ai.azure.com"))) fail(400, "Use an HTTPS Azure OpenAI resource endpoint.");
    const apiKey = text("apiKey");
    const deployment = text("deployment", 120);
    if (!apiKey || !deployment) fail(400, "Azure API key and deployment name are required.");
    return { endpoint: url.origin, apiKey, deployment, apiVersion: text("apiVersion", 40) || "2024-10-21" };
  }
  if (providerId === "bedrock") {
    const region = text("region", 80);
    const accessKeyId = text("accessKeyId", 200);
    const secretAccessKey = text("secretAccessKey", 300);
    if (!/^[a-z]{2}(-gov)?-[a-z]+-\d$/.test(region) || !accessKeyId || !secretAccessKey) fail(400, "AWS region, access key ID, and secret access key are required.");
    return { region, accessKeyId, secretAccessKey, sessionToken: text("sessionToken", 3000) };
  }
  if (providerId === "vertex") {
    const projectId = text("projectId", 200);
    const region = text("region", 80) || "us-central1";
    let serviceAccount;
    try { serviceAccount = JSON.parse(text("serviceAccountJson", 20000)); } catch { fail(400, "Paste valid service account JSON."); }
    if (!projectId || !/^[a-z0-9-]{3,30}$/.test(region) || serviceAccount.type !== "service_account" || !serviceAccount.client_email || !serviceAccount.private_key) fail(400, "A valid project ID, region, and service account JSON with a private key are required.");
    return { projectId, region, serviceAccount };
  }
  if (providerId === "replicate") {
    const apiKey = text("apiKey");
    const model = text("model", 240);
    if (!apiKey || !/^[\w.-]+\/[\w.-]+$/.test(model)) fail(400, "Replicate token and model slug (owner/name) are required.");
    return { apiKey, model };
  }
  if (providerId === "custom") {
    const endpoint = await validateEndpoint(text("endpoint", 2000), process.env.ALLOW_PRIVATE_ENDPOINTS === "true");
    const model = text("model", 240);
    if (!model) fail(400, "Custom model ID is required.");
    return { endpoint, model, apiKey: text("apiKey", 1000) };
  }
  const apiKey = text("apiKey", 2000);
  if (!apiKey) fail(400, "API key is required.");
  return { apiKey };
}

function connectionFor(userId, providerId) {
  const row = db.prepare("SELECT secret FROM connections WHERE user_id = ? AND provider = ?").get(userId, providerId);
  return row ? decrypt(row.secret) : null;
}

async function fetchResponse(url, options) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(90000), redirect: "error" });
  const raw = await response.text();
  let data;
  try { data = JSON.parse(raw); } catch { data = { error: { message: raw.slice(0, 1000) || `HTTP ${response.status}` } }; }
  if (!response.ok) {
    const message = data.error?.message || data.message || `Provider returned HTTP ${response.status}.`;
    throw new Error(String(message).slice(0, 800));
  }
  return data;
}

function modelsEndpoint(endpoint) {
  const url = new URL(endpoint);
  if (!url.pathname.endsWith("/chat/completions")) return null;
  url.pathname = url.pathname.replace(/\/chat\/completions$/, "/models");
  url.search = "";
  return url.toString();
}

async function availableModels(providerId, config) {
  const provider = PROVIDERS[providerId];
  if (!provider) fail(404, "Unknown provider.");
  if (providerId === "azure") return [config.deployment];
  if (providerId === "bedrock" || providerId === "replicate" || providerId === "vertex" || providerId === "cohere") return provider.models || [];

  let endpoint;
  let headers = {};
  if (provider.protocol === "openai-compatible") {
    endpoint = modelsEndpoint(provider.endpoint);
    headers.Authorization = `Bearer ${config.apiKey}`;
  } else if (provider.protocol === "custom") {
    endpoint = modelsEndpoint(await validateEndpoint(config.endpoint, process.env.ALLOW_PRIVATE_ENDPOINTS === "true"));
    if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
  } else if (provider.protocol === "anthropic") {
    endpoint = "https://api.anthropic.com/v1/models?limit=1000";
    headers = { "x-api-key": config.apiKey, "anthropic-version": "2023-06-01" };
  } else if (provider.protocol === "gemini") {
    endpoint = "https://generativelanguage.googleapis.com/v1beta/models";
    headers = { "x-goog-api-key": config.apiKey };
  }
  if (!endpoint) return provider.models || [];

  const data = await fetchResponse(endpoint, { headers });
  const entries = Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : [];
  const ids = entries.map((item) => typeof item === "string" ? item : item.id || item.name?.replace(/^models\//, ""))
    .filter((id) => typeof id === "string" && id && !id.includes("embedding"));
  const unique = [...new Set(ids)];
  if (!unique.length) throw new Error("The provider returned no available models.");
  return unique.slice(0, 200);
}

function signedAwsHeaders(url, body, credentials, region) {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = amzDate.slice(0, 8);
  const payloadHash = crypto.createHash("sha256").update(body).digest("hex");
  const headers = { "content-type": "application/json", host: url.host, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate };
  if (credentials.sessionToken) headers["x-amz-security-token"] = credentials.sessionToken;
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((name) => `${name}:${headers[name].trim()}\n`).join("");
  const signedHeaders = names.join(";");
  const canonicalRequest = `POST\n${url.pathname}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const scope = `${date}/${region}/bedrock/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${crypto.createHash("sha256").update(canonicalRequest).digest("hex")}`;
  const hmac = (key, value) => crypto.createHmac("sha256", key).update(value).digest();
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${credentials.secretAccessKey}`, date), region), "bedrock"), "aws4_request");
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${crypto.createHmac("sha256", signingKey).update(stringToSign).digest("hex")}`;
  return headers;
}

const vertexTokens = new Map();
async function vertexAccessToken(serviceAccount) {
  const cached = vertexTokens.get(serviceAccount.client_email);
  if (cached && cached.expiresAt > Date.now() + 60000) return cached.token;
  const now = Math.floor(Date.now() / 1000);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const tokenUrl = "https://oauth2.googleapis.com/token";
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iss: serviceAccount.client_email, scope: "https://www.googleapis.com/auth/cloud-platform", aud: tokenUrl, iat: now, exp: now + 3600 })}`;
  const assertion = `${unsigned}.${crypto.sign("RSA-SHA256", Buffer.from(unsigned), serviceAccount.private_key).toString("base64url")}`;
  const response = await fetchResponse(tokenUrl, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }) });
  vertexTokens.set(serviceAccount.client_email, { token: response.access_token, expiresAt: Date.now() + response.expires_in * 1000 });
  return response.access_token;
}

async function callProvider(providerId, config, model, messages) {
  const provider = PROVIDERS[providerId];
  if (!provider) throw new Error("Unknown provider.");
  const started = Date.now();
  let data;
  let content;
  let usage = {};
  if (provider.protocol === "openai-compatible") {
    const headers = { "Content-Type": "application/json" };
    if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
    data = await fetchResponse(provider.endpoint, { method: "POST", headers, body: JSON.stringify({ model, messages, stream: false }) });
    content = data.choices?.[0]?.message?.content;
    usage = { inputTokens: data.usage?.prompt_tokens ?? null, outputTokens: data.usage?.completion_tokens ?? null };
  } else if (provider.protocol === "custom") {
    const endpoint = validateEndpoint(config.endpoint, process.env.ALLOW_PRIVATE_ENDPOINTS === "true");
    const headers = { "Content-Type": "application/json" };
    if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
    data = await fetchResponse(endpoint, { method: "POST", headers, body: JSON.stringify({ model: model || config.model, messages, stream: false }) });
    content = data.choices?.[0]?.message?.content;
    usage = { inputTokens: data.usage?.prompt_tokens ?? null, outputTokens: data.usage?.completion_tokens ?? null };
  } else if (provider.protocol === "anthropic") {
    const system = messages.filter((message) => message.role === "system").map((message) => message.content).join("\n");
    data = await fetchResponse("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "Content-Type": "application/json", "x-api-key": config.apiKey, "anthropic-version": "2023-06-01" }, body: JSON.stringify({ model, max_tokens: 4096, system, messages: messages.filter((message) => message.role !== "system") }) });
    content = data.content?.filter((part) => part.type === "text").map((part) => part.text).join("\n");
    usage = { inputTokens: data.usage?.input_tokens ?? null, outputTokens: data.usage?.output_tokens ?? null };
  } else if (provider.protocol === "gemini") {
    const contents = messages.filter((message) => message.role !== "system").map((message) => ({ role: message.role === "assistant" ? "model" : "user", parts: [{ text: message.content }] }));
    const systemInstruction = messages.filter((message) => message.role === "system").map((message) => message.content).join("\n");
    data = await fetchResponse(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": config.apiKey }, body: JSON.stringify({ contents, ...(systemInstruction ? { systemInstruction: { parts: [{ text: systemInstruction }] } } : {}) }) });
    content = data.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("");
    usage = { inputTokens: data.usageMetadata?.promptTokenCount ?? null, outputTokens: data.usageMetadata?.candidatesTokenCount ?? null };
  } else if (provider.protocol === "cohere") {
    data = await fetchResponse("https://api.cohere.com/v2/chat", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` }, body: JSON.stringify({ model, messages }) });
    content = data.message?.content?.filter((part) => part.type === "text").map((part) => part.text).join("\n");
    usage = { inputTokens: data.usage?.tokens?.input_tokens ?? null, outputTokens: data.usage?.tokens?.output_tokens ?? null };
  } else if (provider.protocol === "azure") {
    const url = `${config.endpoint}/openai/deployments/${encodeURIComponent(config.deployment)}/chat/completions?api-version=${encodeURIComponent(config.apiVersion)}`;
    data = await fetchResponse(url, { method: "POST", headers: { "Content-Type": "application/json", "api-key": config.apiKey }, body: JSON.stringify({ messages, max_tokens: 4096 }) });
    content = data.choices?.[0]?.message?.content;
    usage = { inputTokens: data.usage?.prompt_tokens ?? null, outputTokens: data.usage?.completion_tokens ?? null };
  } else if (provider.protocol === "bedrock") {
    const url = new URL(`https://bedrock-runtime.${config.region}.amazonaws.com/model/${encodeURIComponent(model)}/converse`);
    const body = JSON.stringify({ messages: messages.filter((message) => message.role !== "system").map((message) => ({ role: message.role === "assistant" ? "assistant" : "user", content: [{ text: message.content }] })), system: messages.filter((message) => message.role === "system").map((message) => ({ text: message.content })), inferenceConfig: { maxTokens: 4096 } });
    data = await fetchResponse(url, { method: "POST", headers: signedAwsHeaders(url, body, config, config.region), body });
    content = data.output?.message?.content?.map((part) => part.text || "").join("");
    usage = { inputTokens: data.usage?.inputTokens ?? null, outputTokens: data.usage?.outputTokens ?? null };
  } else if (provider.protocol === "vertex") {
    const token = await vertexAccessToken(config.serviceAccount);
    const systemInstruction = messages.filter((message) => message.role === "system").map((message) => message.content).join("\n");
    const contents = messages.filter((message) => message.role !== "system").map((message) => ({ role: message.role === "assistant" ? "model" : "user", parts: [{ text: message.content }] }));
    const url = `https://${config.region}-aiplatform.googleapis.com/v1/projects/${encodeURIComponent(config.projectId)}/locations/${encodeURIComponent(config.region)}/publishers/google/models/${encodeURIComponent(model)}:generateContent`;
    data = await fetchResponse(url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ contents, ...(systemInstruction ? { systemInstruction: { parts: [{ text: systemInstruction }] } } : {}) }) });
    content = data.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("");
    usage = { inputTokens: data.usageMetadata?.promptTokenCount ?? null, outputTokens: data.usageMetadata?.candidatesTokenCount ?? null };
  } else if (provider.protocol === "replicate") {
    const response = await fetchResponse(`https://api.replicate.com/v1/models/${config.model}/predictions`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}`, Prefer: "wait=60" }, body: JSON.stringify({ input: { prompt: messages.map((message) => `${message.role}: ${message.content}`).join("\n") } }) });
    data = response;
    let prediction = response;
    const deadline = Date.now() + 60000;
    while (prediction.status === "starting" || prediction.status === "processing") {
      if (Date.now() > deadline) throw new Error("Replicate prediction timed out; check the prediction in Replicate.");
      await new Promise((resolve) => setTimeout(resolve, 1200));
      prediction = await fetchResponse(prediction.urls.get, { headers: { Authorization: `Bearer ${config.apiKey}` } });
    }
    if (prediction.status !== "succeeded") throw new Error(prediction.error || `Replicate prediction ${prediction.status}.`);
    content = Array.isArray(prediction.output) ? prediction.output.join("") : String(prediction.output ?? "");
    usage = { inputTokens: null, outputTokens: null };
  } else {
    throw new Error("Provider adapter is not implemented.");
  }
  if (typeof content !== "string" || !content.trim()) throw new Error("The provider returned an empty response.");
  return { content, usage, latencyMs: Date.now() - started };
}

function getConversation(userId, id) {
  return db.prepare("SELECT * FROM conversations WHERE id = ? AND user_id = ?").get(id, userId);
}

async function handleApi(req, res, url) {
  const method = req.method;
  const route = url.pathname;
  if (route === "/api/auth/register" && method === "POST") {
    verifyOrigin(req);
    const body = await readJson(req);
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, "Enter a valid email address.");
    if (password.length < 12 || password.length > 200) fail(400, "Password must be between 12 and 200 characters.");
    const id = crypto.randomUUID();
    const salt = crypto.randomBytes(16).toString("hex");
    try {
      db.prepare("INSERT INTO users(id, email, password_salt, password_hash, created_at) VALUES (?, ?, ?, ?, ?)").run(id, email, salt, passwordHash(password, salt), new Date().toISOString());
    } catch (error) {
      if (String(error.message).includes("UNIQUE")) fail(409, "An account with that email already exists.");
      throw error;
    }
    const cookie = createSession(id);
    return json(res, 201, { user: { id, email } }, { "Set-Cookie": cookie });
  }
  if (route === "/api/auth/login" && method === "POST") {
    verifyOrigin(req);
    const body = await readJson(req);
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    const user = db.prepare("SELECT id, email, password_salt, password_hash FROM users WHERE email = ?").get(email);
    const validLength = password.length <= 200;
    const salt = user?.password_salt || DUMMY_SALT;
    const supplied = Buffer.from(passwordHash(validLength ? password : "invalid-password-length", salt), "hex");
    const expected = user ? Buffer.from(user.password_hash, "hex") : DUMMY_PASSWORD_HASH;
    if (!user || !validLength || !crypto.timingSafeEqual(supplied, expected)) fail(401, "Email or password is incorrect.");
    const cookie = createSession(user.id);
    return json(res, 200, { user: { id: user.id, email: user.email } }, { "Set-Cookie": cookie });
  }
  if (route === "/api/auth/logout" && method === "POST") {
    verifyOrigin(req);
    const token = cookieValue(req, COOKIE_NAME);
    if (token) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(token));
    return json(res, 200, { ok: true }, { "Set-Cookie": `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` });
  }
  if (route === "/api/auth/me" && method === "GET") {
    const user = userFromRequest(req);
    return json(res, 200, { user });
  }

  const user = requireUser(req);
  if (route === "/api/providers" && method === "GET") {
    return json(res, 200, { providers: Object.entries(PROVIDERS).map(([id, provider]) => ({ id, name: provider.name, mark: provider.mark, protocol: provider.protocol, models: provider.models, fields: provider.fields || [], placeholder: provider.placeholder })) });
  }
  if (route === "/api/connections" && method === "GET") {
    const rows = db.prepare("SELECT provider, metadata, updated_at FROM connections WHERE user_id = ? ORDER BY provider").all(user.id);
    return json(res, 200, { connections: rows.map((row) => ({ provider: row.provider, settings: JSON.parse(row.metadata), updatedAt: row.updated_at })) });
  }
  const modelsMatch = route.match(/^\/api\/connections\/([a-z0-9-]+)\/models$/);
  if (modelsMatch && method === "GET") {
    const providerId = modelsMatch[1];
    const config = connectionFor(user.id, providerId);
    if (!config) fail(404, "Connect this provider first.");
    try {
      const models = await availableModels(providerId, config);
      return json(res, 200, { models });
    } catch (error) {
      return json(res, 502, { error: `${PROVIDERS[providerId].name} model list failed: ${String(error.message || "Could not load models.").slice(0, 800)}` });
    }
  }
  const connectionMatch = route.match(/^\/api\/connections\/([a-z0-9-]+)$/);
  if (connectionMatch && method === "PUT") {
    verifyOrigin(req);
    const providerId = connectionMatch[1];
    const config = await validateConnection(providerId, await readJson(req));
    const updatedAt = new Date().toISOString();
    db.prepare(`INSERT INTO connections(user_id, provider, secret, metadata, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id, provider) DO UPDATE SET secret = excluded.secret, metadata = excluded.metadata, updated_at = excluded.updated_at`)
      .run(user.id, providerId, encrypt(config), JSON.stringify(safeMetadata(providerId, config)), updatedAt);
    return json(res, 200, { connection: { provider: providerId, settings: safeMetadata(providerId, config), updatedAt } });
  }
  if (connectionMatch && method === "DELETE") {
    verifyOrigin(req);
    db.prepare("DELETE FROM connections WHERE user_id = ? AND provider = ?").run(user.id, connectionMatch[1]);
    return json(res, 200, { ok: true });
  }
  const testMatch = route.match(/^\/api\/connections\/([a-z0-9-]+)\/test$/);
  if (testMatch && method === "POST") {
    verifyOrigin(req);
    const providerId = testMatch[1];
    const config = connectionFor(user.id, providerId);
    if (!config) fail(404, "Connect this provider first.");
    const provider = PROVIDERS[providerId];
    const model = provider.protocol === "azure" ? config.deployment : provider.protocol === "replicate" ? config.model : provider.protocol === "custom" ? config.model : provider.models[0];
    try {
      const result = await callProvider(providerId, config, model, [{ role: "user", content: "Reply with OK." }]);
      return json(res, 200, { ok: true, model, latencyMs: result.latencyMs });
    } catch (error) {
      return json(res, 502, { error: `${provider.name} test failed: ${String(error.message || "Provider request failed.").slice(0, 800)}` });
    }
  }
  if (route === "/api/overview" && method === "GET") {
    const connections = db.prepare("SELECT COUNT(*) AS count FROM connections WHERE user_id = ?").get(user.id).count;
    const conversations = db.prepare("SELECT COUNT(*) AS count FROM conversations WHERE user_id = ?").get(user.id).count;
    const prompts = db.prepare(`SELECT COUNT(*) AS count FROM messages JOIN conversations ON conversations.id = messages.conversation_id WHERE conversations.user_id = ? AND messages.role = 'user'`).get(user.id).count;
    const responses = db.prepare(`SELECT COUNT(*) AS count FROM messages JOIN conversations ON conversations.id = messages.conversation_id WHERE conversations.user_id = ? AND messages.role = 'assistant' AND messages.status = 'ok'`).get(user.id).count;
    const activity = db.prepare(`SELECT conversations.title, messages.content, messages.created_at,
      (SELECT COUNT(*) FROM messages r WHERE r.conversation_id = messages.conversation_id AND r.created_at >= messages.created_at
        AND r.created_at < COALESCE((SELECT MIN(next.created_at) FROM messages next WHERE next.conversation_id = messages.conversation_id AND next.role = 'user' AND next.created_at > messages.created_at), '9999-12-31T23:59:59.999Z')
        AND r.role = 'assistant' AND r.status = 'ok') AS responses
      FROM messages JOIN conversations ON conversations.id = messages.conversation_id
      WHERE conversations.user_id = ? AND messages.role = 'user' ORDER BY messages.created_at DESC LIMIT 10`).all(user.id);
    const tokens = db.prepare(`SELECT COALESCE(SUM(input_tokens),0) AS input, COALESCE(SUM(output_tokens),0) AS output,
      COALESCE(AVG(latency_ms),0) AS latency FROM messages JOIN conversations ON conversations.id = messages.conversation_id
      WHERE conversations.user_id = ? AND messages.role = 'assistant' AND messages.status = 'ok'`).get(user.id);
    return json(res, 200, { stats: { connections, conversations, prompts, responses, inputTokens: tokens.input, outputTokens: tokens.output, averageLatencyMs: Math.round(tokens.latency) }, activity });
  }
  if (route === "/api/conversations" && method === "GET") {
    return json(res, 200, { conversations: db.prepare("SELECT id, title, created_at AS createdAt, updated_at AS updatedAt FROM conversations WHERE user_id = ? ORDER BY updated_at DESC LIMIT 100").all(user.id) });
  }
  if (route === "/api/conversations" && method === "POST") {
    verifyOrigin(req);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    db.prepare("INSERT INTO conversations(id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(id, user.id, "New conversation", now, now);
    return json(res, 201, { conversation: { id, title: "New conversation", createdAt: now, updatedAt: now } });
  }
  const conversationMatch = route.match(/^\/api\/conversations\/([0-9a-f-]+)$/i);
  if (conversationMatch && method === "GET") {
    const conversation = getConversation(user.id, conversationMatch[1]);
    if (!conversation) fail(404, "Conversation not found.");
    const messages = db.prepare("SELECT id, role, provider, model, content, status, input_tokens AS inputTokens, output_tokens AS outputTokens, latency_ms AS latencyMs, created_at AS createdAt FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid").all(conversation.id);
    return json(res, 200, { conversation: { id: conversation.id, title: conversation.title }, messages });
  }
  if (conversationMatch && method === "DELETE") {
    verifyOrigin(req);
    db.prepare("DELETE FROM conversations WHERE id = ? AND user_id = ?").run(conversationMatch[1], user.id);
    return json(res, 200, { ok: true });
  }
  if (route === "/api/chat" && method === "POST") {
    verifyOrigin(req);
    const body = await readJson(req);
    const conversation = getConversation(user.id, String(body.conversationId || ""));
    if (!conversation) fail(404, "Choose a saved conversation first.");
    const prompt = String(body.prompt || "").trim();
    if (!prompt || prompt.length > 30000) fail(400, "Prompt must contain 1 to 30,000 characters.");
    const requested = Array.isArray(body.models) ? body.models.slice(0, 6) : [];
    if (!requested.length) fail(400, "Select at least one model.");
    const now = new Date().toISOString();
    db.prepare("INSERT INTO messages(id, conversation_id, role, content, created_at) VALUES (?, ?, 'user', ?, ?)").run(crypto.randomUUID(), conversation.id, prompt, now);
    if (conversation.title === "New conversation") {
      db.prepare("UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?").run(prompt.slice(0, 70), now, conversation.id);
    } else {
      db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(now, conversation.id);
    }
    const historyRows = db.prepare("SELECT role, provider, model, content FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid").all(conversation.id);
    const outcomes = await Promise.all(requested.map(async (selection) => {
      const providerId = String(selection.provider || "");
      const provider = PROVIDERS[providerId];
      const model = String(selection.model || "").slice(0, 240);
      const config = connectionFor(user.id, providerId);
      if (!provider || !model || !config) {
        const message = "Provider is not connected or model is invalid.";
        if (provider && model) db.prepare(`INSERT INTO messages(id, conversation_id, role, provider, model, content, status, created_at)
          VALUES (?, ?, 'assistant', ?, ?, ?, 'error', ?)`)
          .run(crypto.randomUUID(), conversation.id, providerId, model, message, new Date().toISOString());
        return { provider: providerId, model, status: "error", error: message };
      }
      try {
        const history = historyRows.slice(0, -1).filter((message) => message.role !== "assistant" || (message.provider === providerId && message.model === model)).map((message) => ({ role: message.role === "assistant" ? "assistant" : "user", content: message.content }));
        const result = await callProvider(providerId, config, model, [...history, { role: "user", content: prompt }]);
        db.prepare(`INSERT INTO messages(id, conversation_id, role, provider, model, content, status, input_tokens, output_tokens, latency_ms, created_at)
          VALUES (?, ?, 'assistant', ?, ?, ?, 'ok', ?, ?, ?, ?)`)
          .run(crypto.randomUUID(), conversation.id, providerId, model, result.content, result.usage.inputTokens, result.usage.outputTokens, result.latencyMs, new Date().toISOString());
        return { provider: providerId, model, status: "ok", content: result.content, usage: result.usage, latencyMs: result.latencyMs };
      } catch (error) {
        const message = String(error.message || "Provider request failed.").slice(0, 800);
        db.prepare(`INSERT INTO messages(id, conversation_id, role, provider, model, content, status, created_at)
          VALUES (?, ?, 'assistant', ?, ?, ?, 'error', ?)`)
          .run(crypto.randomUUID(), conversation.id, providerId, model, message, new Date().toISOString());
        return { provider: providerId, model, status: "error", error: message };
      }
    }));
    return json(res, 200, { conversationId: conversation.id, prompt, responses: outcomes });
  }
  fail(404, "API route not found.");
}

const mimeTypes = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };
const failures = new Map();
function rateLimit(req) {
  const key = req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const state = failures.get(key) || { count: 0, reset: now + 60000 };
  if (now > state.reset) { state.count = 0; state.reset = now + 60000; }
  state.count++;
  failures.set(key, state);
  if (state.count > 30) fail(429, "Too many requests. Try again shortly.");
}

const server = http.createServer(async (req, res) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    if (url.pathname.startsWith("/api/")) {
      if (url.pathname === "/api/auth/login" || url.pathname === "/api/auth/register") rateLimit(req);
      return await handleApi(req, res, url);
    }
    if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error: "Method not allowed." });
    const relative = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname).replace(/^\/+/, "");
    const file = path.resolve(ROOT, relative);
    if (!file.startsWith(`${ROOT}${path.sep}`)) return json(res, 403, { error: "Forbidden." });
    let stat;
    try { stat = fs.statSync(file); } catch { return json(res, 404, { error: "Not found." }); }
    if (!stat.isFile()) return json(res, 404, { error: "Not found." });
    res.writeHead(200, { "Content-Type": mimeTypes[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(file).pipe(res);
  } catch (error) {
    if (res.headersSent) return res.destroy();
    json(res, error.status || 500, { error: error.status ? error.message : "Server error." });
    if (!error.status) console.error(error);
  }
});

server.listen(PORT, "0.0.0.0", () => console.log(`Model Desk running on http://localhost:${PORT}`));