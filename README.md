# Model Desk

A self-hosted multi-user AI workspace with account sign-in, encrypted provider connections, persistent conversations, provider comparisons, and a usage dashboard.

## Run locally

Requires Node.js 22.5 or later. No npm dependencies are required.

```sh
npm start
```

Open http://localhost:4173 and create an account. Passwords must be at least 12 characters.

## Provider support

Includes OpenAI, Anthropic, Groq, xAI, Gemini, Mistral, DeepSeek, OpenRouter, Together AI, Fireworks AI, Cerebras, Perplexity, SambaNova, NVIDIA NIM, DeepInfra, Hugging Face, Cohere, Azure OpenAI, AWS Bedrock, Vertex AI, Replicate, and a custom OpenAI-compatible endpoint.

The custom endpoint expects a chat-completions API. Set `ALLOW_PRIVATE_ENDPOINTS=true` to connect local inference servers such as Ollama. Only enable private-network endpoints on a trusted, self-hosted instance.

## Security and storage

- Provider credentials are encrypted with AES-256-GCM in the local SQLite database. They are never returned to the browser.
- For local development, the server creates `data/master.key`. Keep the `data/` directory private and backed up; losing the key makes saved credentials unreadable.
- For deployment, provide a stable 32-byte key as 64 hex characters in `APP_SECRET_KEY`, terminate HTTPS at a trusted proxy, set `NODE_ENV=production`, and protect the database and key backups.
- Each account has private connections and conversations. Shared workspaces and invitations are not included yet.
- The dashboard reports stored prompts, successful responses, tokens, and average latency. Pricing varies by model and is not estimated in this MVP.
- The API tab discovers account-available models for OpenAI-compatible providers, Anthropic, and Gemini. Other providers use curated fallback lists.
- Model catalogs and access vary by account. Refresh the model list in API settings when needed; model IDs can also be typed directly in Chat when a provider account exposes models outside its catalog endpoint.
