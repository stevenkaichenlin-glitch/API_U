(() => {
  const state = {
    user: null,
    providers: [],
    providerById: new Map(),
    connections: new Map(),
    modelErrors: new Map(),
    conversations: [],
    conversationId: null,
    messages: [],
    lanes: [
      { provider: "openai", model: "gpt-4.1", turns: [], loading: false, error: "" },
      { provider: "anthropic", model: "claude-sonnet-4-20250514", turns: [], loading: false, error: "" },
      { provider: "groq", model: "openai/gpt-oss-120b", turns: [], loading: false, error: "" },
      { provider: "xai", model: "grok-3", turns: [], loading: false, error: "" }
    ],
    view: "dashboard",
    authMode: "register",
    busy: false
  };

  const $ = (id) => document.getElementById(id);
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  const fieldLabels = {
    apiKey: "API key", endpoint: "Resource endpoint", deployment: "Deployment name", apiVersion: "API version",
    region: "AWS region", accessKeyId: "AWS access key ID", secretAccessKey: "AWS secret access key", sessionToken: "Session token (optional)",
    projectId: "Google Cloud project ID", serviceAccountJson: "Service account JSON", model: "Model ID (owner/name for Replicate)"
  };
  const secretFields = new Set(["apiKey", "secretAccessKey", "sessionToken", "serviceAccountJson"]);

  async function api(path, options = {}) {
    const response = await fetch(path, {
      credentials: "same-origin",
      ...options,
      headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401 && state.user && path !== "/api/auth/logout") showAuth();
      throw new Error(data.error || `Request failed (${response.status}).`);
    }
    return data;
  }

  function toast(message) {
    const node = $("toast");
    node.textContent = message;
    node.classList.add("visible");
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => node.classList.remove("visible"), 3200);
  }

  function showAuth(error = "") {
    state.user = null;
    $("authView").hidden = false;
    $("appRoot").hidden = true;
    $("authError").hidden = !error;
    $("authError").textContent = error;
    $("authTitle").textContent = state.authMode === "register" ? "Create your workspace" : "Welcome back";
    $("authDescription").textContent = state.authMode === "register" ? "Sign up to connect providers and save model conversations." : "Sign in to continue to your private workspace.";
    $("authSubmit").textContent = state.authMode === "register" ? "Create account" : "Sign in";
    $("authSwitchCopy").textContent = state.authMode === "register" ? "Already have an account?" : "New to Model Desk?";
    $("authSwitch").textContent = state.authMode === "register" ? "Sign in" : "Create account";
    $("authPassword").autocomplete = state.authMode === "register" ? "new-password" : "current-password";
  }

  function setView(view) {
    state.view = view;
    $("dashboardView").hidden = view !== "dashboard";
    $("chatView").hidden = view !== "chat";
    $("chatComposer").hidden = view !== "chat";
    $("apiView").hidden = view !== "api";
    $("pageTitle").textContent = view === "dashboard" ? "Dashboard" : view === "api" ? "API" : "Chat";
    for (const [id, name] of [["dashboardNav", "dashboard"], ["chatNav", "chat"], ["apiNav", "api"]]) {
      const active = name === view;
      $(id).classList.toggle("active", active);
      $(id).toggleAttribute("aria-current", active);
    }
    if (view === "api") renderProviders();
    if (view === "dashboard") loadDashboard();
  }

  function connected(id) {
    return state.connections.has(id);
  }

  function modelOptions(provider) {
    const settings = state.connections.get(provider.id)?.settings || {};
    if (["azure"].includes(provider.id)) return settings.deployment ? [settings.deployment] : [];
    if (provider.id === "replicate") return settings.model ? [settings.model] : [];
    if (provider.id === "custom") return provider.models?.length ? provider.models : settings.model ? [settings.model] : [];
    return provider.models || [];
  }

  function defaultModel(providerId) {
    const provider = state.providerById.get(providerId);
    return modelOptions(provider || { id: providerId })[0] || provider?.models?.[0] || "";
  }

  function renderModelPicker() {
    $("composerModelCount").textContent = state.lanes.length;
    $("modelPickerList").innerHTML = state.lanes.map((lane, index) => {
      const provider = state.providerById.get(lane.provider);
      if (!provider) return "";
      const options = modelOptions(provider);
      const isCatalogModel = options.includes(lane.model);
      return `<div class="picker-lane"><label class="picker-field">Provider<select class="lane-provider" data-lane="${index}" aria-label="Provider for model ${index + 1}">${state.providers.map((item) => `<option value="${escapeHtml(item.id)}" ${item.id === lane.provider ? "selected" : ""}>${escapeHtml(item.name)}${connected(item.id) ? " · Connected" : ""}</option>`).join("")}</select></label><label class="picker-field">Model<select class="model-select" data-lane="${index}" aria-label="Model for ${escapeHtml(provider.name)}"><option value="__custom__" ${isCatalogModel ? "" : "selected"}>Custom model ID</option>${options.map((option) => `<option value="${escapeHtml(option)}" ${option === lane.model ? "selected" : ""}>${escapeHtml(option)}</option>`).join("")}</select></label><div class="picker-lane-actions">${connected(provider.id) && supportsLiveModels(provider) ? `<button class="icon-button" type="button" data-refresh-lane="${escapeHtml(provider.id)}" aria-label="Refresh ${escapeHtml(provider.name)} models" title="Refresh models">↻</button>` : ""}<button class="icon-button remove-lane" type="button" data-lane="${index}" aria-label="Remove ${escapeHtml(provider.name)}" title="Remove model" ${state.lanes.length <= 1 ? "hidden" : ""}>×</button></div><input class="model-custom" data-lane="${index}" aria-label="Custom model ID for ${escapeHtml(provider.name)}" placeholder="Enter model ID" value="${isCatalogModel ? "" : escapeHtml(lane.model)}" ${isCatalogModel ? "hidden" : ""}></div>`;
    }).join("");
  }

  function renderModels() {
    $("modelGrid").innerHTML = state.lanes.map((lane, index) => {
      const provider = state.providerById.get(lane.provider);
      if (!provider) return "";
      const options = modelOptions(provider);
      const model = lane.model || options[0] || provider.models?.[0] || "Model ID required";
      const liveModelError = state.modelErrors.get(lane.provider);
      const needsGroqTerms = lane.provider === "groq" && /term|accept|agreement|access/i.test(lane.error);
      const groqTermsUrl = `https://console.groq.com/playground?model=${encodeURIComponent(lane.model)}`;
      const latest = [...lane.turns].reverse().find((turn) => turn.role === "assistant");
      const body = lane.loading
        ? `<div class="empty-state"><span class="empty-orbit">···</span><strong>Waiting for ${escapeHtml(provider.name)}</strong></div>`
        : lane.error
          ? `<div class="empty-state"><strong>Response failed</strong><span class="response-error">${escapeHtml(lane.error)}</span>${needsGroqTerms ? `<a class="model-terms-link" href="${escapeHtml(groqTermsUrl)}" target="_blank" rel="noopener noreferrer">Open Groq model terms</a>` : ""}<button type="button" data-action="configure">Configure API</button></div>`
          : latest
            ? `<p class="response">${escapeHtml(latest.content)}</p><div class="response-meta">${latest.latencyMs != null ? `${latest.latencyMs} ms` : ""}${latest.inputTokens != null || latest.outputTokens != null ? ` · ${latest.inputTokens ?? "?"} in / ${latest.outputTokens ?? "?"} out tokens` : ""}</div>`
            : `<div class="empty-state"><span class="empty-orbit">${connected(lane.provider) ? "OK" : "API"}</span><strong>${connected(lane.provider) ? "Ready for a prompt" : `Connect ${escapeHtml(provider.name)}`}</strong><span>${connected(lane.provider) ? "Responses will appear here." : "Configure this provider to include it."}</span>${connected(lane.provider) ? "" : "<button type=\"button\" data-action=\"configure\">Open API settings</button>"}</div>`;
      return `<article class="model-card"><div class="model-head"><span class="provider-mark ${escapeHtml(provider.id)}">${escapeHtml(provider.mark)}</span><div class="model-heading"><strong>${escapeHtml(model)}</strong><span>${escapeHtml(provider.name)}</span></div><span class="lane-status ${connected(provider.id) ? "connected" : ""}">${connected(provider.id) ? "Connected" : "Not connected"}</span></div><div class="model-body">${liveModelError ? `<p class="provider-help model-list-error">Model list unavailable: ${escapeHtml(liveModelError)}</p>` : ""}${body}</div></article>`;
    }).join("");
    $("targetCount").textContent = `${state.lanes.filter((lane) => connected(lane.provider)).length} connected`;
    $("answerCount").textContent = `· ${state.lanes.length} model${state.lanes.length === 1 ? "" : "s"}`;
    renderModelPicker();
  }

  function fieldList(provider) {
    if (provider.id === "azure") return ["endpoint", "deployment", "apiVersion", "apiKey"];
    if (provider.id === "bedrock") return ["region", "accessKeyId", "secretAccessKey", "sessionToken"];
    if (provider.id === "vertex") return ["projectId", "region", "serviceAccountJson"];
    if (provider.id === "replicate") return ["model", "apiKey"];
    if (provider.id === "custom") return ["endpoint", "model", "apiKey"];
    return ["apiKey"];
  }

  function supportsLiveModels(provider) {
    return ["openai-compatible", "custom", "anthropic", "gemini"].includes(provider.protocol);
  }

  async function refreshProviderModels(providerId, quiet = false) {
    const provider = state.providerById.get(providerId);
    try {
      const result = await api(`/api/connections/${encodeURIComponent(providerId)}/models`);
      if (!result.models.length) throw new Error("This provider returned no available models.");
      provider.models = result.models;
      state.modelErrors.delete(providerId);
      for (const lane of state.lanes) {
        if (lane.provider === providerId && !lane.turns.length && !result.models.includes(lane.model)) lane.model = result.models[0];
      }
      if (!quiet) toast(`${provider.name}: ${result.models.length} models available.`);
    } catch (error) {
      state.modelErrors.set(providerId, error.message);
      if (!quiet) toast(error.message);
      throw error;
    } finally {
      renderModels();
      if (state.view === "api") renderProviders();
    }
  }

  function renderField(provider, name) {
    const settings = state.connections.get(provider.id)?.settings || {};
    const wide = name === "serviceAccountJson" || name === "endpoint";
    const label = fieldLabels[name] || name;
    const placeholder = name === "apiKey" ? provider.placeholder : name === "serviceAccountJson" ? "Paste service account JSON" : name === "endpoint" ? "https://resource.example/v1/chat/completions" : name === "model" ? provider.id === "replicate" ? "owner/model" : "model-id" : name === "apiVersion" ? "2024-10-21" : name === "region" ? provider.id === "bedrock" ? "us-east-1" : "us-central1" : "";
    const value = secretFields.has(name) ? "" : settings[name] || "";
    const required = !["sessionToken", "apiKey"].includes(name) || (provider.id !== "custom" && name === "apiKey");
    if (name === "serviceAccountJson") return `<label class="provider-field wide">${escapeHtml(label)}<textarea name="${name}" placeholder="${escapeHtml(placeholder)}" ${required ? "required" : ""}></textarea></label>`;
    const type = secretFields.has(name) ? "password" : name === "endpoint" ? "url" : "text";
    return `<label class="provider-field ${wide ? "wide" : ""}">${escapeHtml(label)}<input name="${name}" type="${type}" value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}" autocomplete="${secretFields.has(name) ? "new-password" : "off"}" ${required ? "required" : ""} maxlength="20000"></label>`;
  }

  function renderProviders() {
    const filter = $("providerSearch").value.trim().toLowerCase();
    const providers = state.providers.filter((provider) => provider.name.toLowerCase().includes(filter));
    $("apiProviderList").innerHTML = providers.length ? providers.map((provider) => {
      const isConnected = connected(provider.id);
      const inputs = fieldList(provider).map((field) => renderField(provider, field)).join("");
      const modelNames = state.modelErrors.has(provider.id)
        ? `<span class="model-list-error">Model discovery failed: ${escapeHtml(state.modelErrors.get(provider.id))}</span>`
        : provider.models?.length ? `${provider.models.length} model options · ${provider.models.slice(0, 3).map(escapeHtml).join(" · ")}` : provider.fields?.join(" · ") || "Compatible endpoint";
      const refreshButton = isConnected && supportsLiveModels(provider) ? `<button class="test-provider" type="button" data-refresh-models="${escapeHtml(provider.id)}">Refresh models</button>` : "";
      return `<section class="provider-row" data-provider="${escapeHtml(provider.id)}"><div class="provider-title"><span class="provider-mark ${escapeHtml(provider.id)}">${escapeHtml(provider.mark)}</span><strong>${escapeHtml(provider.name)}</strong><span class="key-state">${isConnected ? "Connected" : "Not connected"}</span></div><p class="provider-help">${modelNames}</p><form class="provider-form" data-provider="${escapeHtml(provider.id)}"><div class="provider-config">${inputs}</div><div class="provider-actions"><button type="submit">${isConnected ? "Update connection" : "Connect"}</button>${isConnected ? `<button class="test-provider" type="button" data-test="${escapeHtml(provider.id)}">Test connection</button>${refreshButton}<button class="disconnect-provider" type="button" data-disconnect="${escapeHtml(provider.id)}">Disconnect</button>` : ""}</div></form></section>`;
    }).join("") : `<div class="dashboard-empty">No providers match this search.</div>`;
    $("connectedCount").textContent = state.connections.size;
    $("connectionSummary").textContent = `${state.connections.size} provider${state.connections.size === 1 ? "" : "s"} connected`;
  }

  async function loadConnections() {
    const result = await api("/api/connections");
    state.connections = new Map(result.connections.map((item) => [item.provider, item]));
    renderProviders();
    renderModels();
  }

  async function loadDashboard() {
    try {
      const { stats, activity } = await api("/api/overview");
      $("statConnected").textContent = stats.connections;
      $("statConversations").textContent = stats.conversations;
      $("statPrompts").textContent = stats.prompts;
      $("statResponses").textContent = stats.responses;
      const inputTokens = stats.inputTokens || 0;
      const outputTokens = stats.outputTokens || 0;
      $("statTokens").textContent = (inputTokens + outputTokens).toLocaleString();
      $("tokenBreakdown").textContent = `${inputTokens.toLocaleString()} in · ${outputTokens.toLocaleString()} out`;
      $("statLatency").textContent = `${stats.averageLatencyMs || 0} ms`;
      $("activityContent").innerHTML = activity.length
        ? `<table class="activity-table"><thead><tr><th>Prompt</th><th>Time</th><th>Responses</th></tr></thead><tbody>${activity.map((item) => `<tr><td title="${escapeHtml(item.content)}">${escapeHtml(item.content)}</td><td>${escapeHtml(new Date(item.created_at).toLocaleString())}</td><td>${item.responses}</td></tr>`).join("")}</tbody></table>`
        : `<div class="activity-table dashboard-empty">No prompts yet. Start a conversation to see activity here.</div>`;
    } catch (error) { toast(error.message); }
  }

  async function loadConversation(id) {
    const result = await api(`/api/conversations/${encodeURIComponent(id)}`);
    state.conversationId = result.conversation.id;
    state.messages = result.messages;
    const latestPromptIndex = state.messages.findLastIndex((message) => message.role === "user");
    const savedModels = [...new Map(state.messages.filter((message) => message.role === "assistant" && message.provider && message.model).map((message) => [`${message.provider}:${message.model}`, { provider: message.provider, model: message.model }])).values()].slice(0, 6);
    if (savedModels.length) state.lanes = savedModels.map((lane) => ({ ...lane, turns: [], loading: false, error: "" }));
    for (const lane of state.lanes) {
      lane.turns = state.messages.filter((message) => message.role === "user" || (message.role === "assistant" && message.provider === lane.provider && message.model === lane.model)).map((message) => ({ role: message.role, content: message.content, status: message.status, latencyMs: message.latencyMs, inputTokens: message.inputTokens, outputTokens: message.outputTokens }));
      const latestResponse = state.messages.slice(latestPromptIndex + 1).findLast((message) => message.role === "assistant" && message.provider === lane.provider && message.model === lane.model);
      lane.error = latestResponse?.status === "error" ? latestResponse.content : "";
    }
    const latestPrompt = [...state.messages].reverse().find((message) => message.role === "user");
    $("latestPrompt").textContent = latestPrompt?.content || "Send a prompt to compare responses from the selected models.";
    $("promptTime").textContent = latestPrompt ? new Date(latestPrompt.createdAt).toLocaleString() : "Ready when you are";
    renderModels();
    renderConversations();
  }

  async function loadConversations() {
    const result = await api("/api/conversations");
    state.conversations = result.conversations;
    renderConversations();
    if (state.conversations.length) await loadConversation(state.conversations[0].id);
    else await newConversation();
  }

  function renderConversations() {
    $("conversationList").innerHTML = state.conversations.map((conversation) => `<button class="side-link ${conversation.id === state.conversationId ? "active" : ""}" type="button" data-conversation="${escapeHtml(conversation.id)}" title="${escapeHtml(conversation.title)}">${escapeHtml(conversation.title)}</button>`).join("");
  }

  async function newConversation() {
    const result = await api("/api/conversations", { method: "POST" });
    state.conversations.unshift(result.conversation);
    state.messages = [];
    for (const lane of state.lanes) { lane.turns = []; lane.error = ""; }
    state.conversationId = result.conversation.id;
    $("latestPrompt").textContent = "Send a prompt to compare responses from the selected models.";
    $("promptTime").textContent = "Ready when you are";
    renderConversations();
    renderModels();
    setView("chat");
  }

  async function loadWorkspace() {
    const [catalog] = await Promise.all([api("/api/providers"), loadConnections()]);
    state.providers = catalog.providers;
    state.providerById = new Map(state.providers.map((provider) => [provider.id, provider]));
    $("accountLabel").textContent = state.user.email;
    $("authView").hidden = true;
    $("appRoot").hidden = false;
    await loadConnections();
    await Promise.all(state.providers.filter((provider) => connected(provider.id) && supportsLiveModels(provider)).map((provider) => refreshProviderModels(provider.id, true).catch(() => {})));
    await loadConversations();
    setView("dashboard");
  }

  async function newAuthSession(data) {
    state.user = data.user;
    $("authView").hidden = true;
    $("appRoot").hidden = false;
    await loadWorkspace();
  }

  function setAuthBusy(busy) {
    $("authSubmit").disabled = busy;
    $("authSubmit").textContent = busy ? "Please wait…" : state.authMode === "register" ? "Create account" : "Sign in";
  }

  $("authForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    $("authError").hidden = true;
    setAuthBusy(true);
    try {
      const result = await api(`/api/auth/${state.authMode}`, { method: "POST", body: JSON.stringify({ email: $("authEmail").value, password: $("authPassword").value }) });
      $("authPassword").value = "";
      await newAuthSession(result);
    } catch (error) {
      showAuth(error.message);
    } finally { setAuthBusy(false); }
  });

  $("authSwitch").addEventListener("click", () => {
    state.authMode = state.authMode === "register" ? "login" : "register";
    showAuth();
  });
  $("logoutButton").addEventListener("click", async () => {
    try { await api("/api/auth/logout", { method: "POST" }); }
    finally { state.user = null; showAuth(); }
  });
  $("dashboardNav").addEventListener("click", () => setView("dashboard"));
  $("chatNav").addEventListener("click", () => setView("chat"));
  $("apiNav").addEventListener("click", () => setView("api"));
  $("dashboardChat").addEventListener("click", () => setView("chat"));
  $("openKeys").addEventListener("click", () => setView("api"));
  $("newConversation").addEventListener("click", () => newConversation().catch((error) => toast(error.message)));
  $("newThread").addEventListener("click", () => newConversation().catch((error) => toast(error.message)));
  $("clearThread").addEventListener("click", async () => {
    if (!state.conversationId) return;
    try {
      await api(`/api/conversations/${encodeURIComponent(state.conversationId)}`, { method: "DELETE" });
      state.conversations = state.conversations.filter((conversation) => conversation.id !== state.conversationId);
      await newConversation();
      await loadDashboard();
    } catch (error) { toast(error.message); }
  });

  $("conversationList").addEventListener("click", (event) => {
    const button = event.target.closest("[data-conversation]");
    if (!button) return;
    loadConversation(button.dataset.conversation).then(() => setView("chat")).catch((error) => toast(error.message));
  });

  $("providerSearch").addEventListener("input", renderProviders);
  $("apiProviderList").addEventListener("submit", async (event) => {
    const form = event.target.closest("form[data-provider]");
    if (!form) return;
    event.preventDefault();
    const providerId = form.dataset.provider;
    const config = Object.fromEntries(new FormData(form).entries());
    const submit = form.querySelector("[type=submit]");
    submit.disabled = true;
    try {
      const result = await api(`/api/connections/${encodeURIComponent(providerId)}`, { method: "PUT", body: JSON.stringify(config) });
      state.connections.set(providerId, result.connection);
      if (supportsLiveModels(state.providerById.get(providerId))) await refreshProviderModels(providerId, true).catch(() => {});
      renderProviders();
      renderModels();
      await loadDashboard();
      toast(`${state.providerById.get(providerId).name} connected.`);
    } catch (error) { toast(error.message); }
    finally { submit.disabled = false; }
  });

  $("apiProviderList").addEventListener("click", async (event) => {
    const disconnect = event.target.closest("[data-disconnect]");
    const test = event.target.closest("[data-test]");
    const refresh = event.target.closest("[data-refresh-models]");
    if (disconnect) {
      const providerId = disconnect.dataset.disconnect;
      try {
        await api(`/api/connections/${encodeURIComponent(providerId)}`, { method: "DELETE" });
        state.connections.delete(providerId);
        renderProviders();
        renderModels();
        await loadDashboard();
        toast(`${state.providerById.get(providerId).name} disconnected.`);
      } catch (error) { toast(error.message); }
    }
    if (test) {
      const providerId = test.dataset.test;
      test.disabled = true;
      try {
        const result = await api(`/api/connections/${encodeURIComponent(providerId)}/test`, { method: "POST" });
        toast(`Connection verified in ${result.latencyMs} ms. Provider may bill for this test.`);
      } catch (error) { toast(error.message); }
      finally { test.disabled = false; }
    }
    if (refresh) {
      refresh.disabled = true;
      try { await refreshProviderModels(refresh.dataset.refreshModels); }
      catch (error) { toast(error.message); }
      finally { refresh.disabled = false; }
    }
  });

  $("addModel").addEventListener("click", () => {
    if (state.lanes.length >= 6) return toast("A comparison can include up to 6 models.");
    const unusedProvider = state.providers.find((item) => !state.lanes.some((lane) => lane.provider === item.id));
    const provider = unusedProvider || state.providers.find((item) => connected(item.id) && modelOptions(item).some((model) => !state.lanes.some((lane) => lane.provider === item.id && lane.model === model)));
    if (!provider) return toast("Connect another provider or change an existing model to add a comparison.");
    const model = modelOptions(provider).find((option) => !state.lanes.some((lane) => lane.provider === provider.id && lane.model === option)) || "";
    state.lanes.push({ provider: provider.id, model, turns: [], loading: false, error: "" });
    renderModels();
  });

  $("modelPickerList").addEventListener("change", (event) => {
    const lane = state.lanes[Number(event.target.dataset.lane)];
    if (!lane) return;
    if (event.target.matches(".lane-provider")) {
      const providerId = event.target.value;
      const provider = state.providerById.get(providerId);
      const selectedModels = state.lanes.filter((item) => item !== lane && item.provider === providerId).map((item) => item.model);
      const model = modelOptions(provider).find((option) => !selectedModels.includes(option)) || "";
      lane.provider = providerId;
      lane.model = model;
      lane.turns = [];
      lane.error = "";
      renderModels();
      return;
    }
    if (!event.target.matches(".model-select, .model-custom")) return;
    if (event.target.matches(".model-select") && event.target.value === "__custom__") {
      const input = event.target.closest(".picker-lane").querySelector(".model-custom");
      input.hidden = false;
      input.focus();
      return;
    }
    const model = event.target.value.trim();
    if (!model) return toast("Enter a model ID to continue.");
    if (state.lanes.some((item) => item !== lane && item.provider === lane.provider && item.model === model)) return toast("That provider and model are already selected.");
    lane.model = model;
    lane.turns = [];
    lane.error = "";
    renderModels();
  });
  $("modelPicker").addEventListener("click", (event) => {
    const remove = event.target.closest(".remove-lane");
    const refresh = event.target.closest("[data-refresh-lane]");
    if (remove && state.lanes.length > 1) {
      state.lanes.splice(Number(remove.dataset.lane), 1);
      renderModels();
    }
    if (refresh) refreshProviderModels(refresh.dataset.refreshLane).catch((error) => toast(error.message));
  });
  $("modelGrid").addEventListener("click", (event) => {
    if (event.target.closest('[data-action="configure"]')) setView("api");
  });

  $("chatForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (state.busy) return;
    const prompt = $("promptInput").value.trim();
    if (!prompt) return;
    const activeLanes = state.lanes.filter((lane) => connected(lane.provider));
    if (!activeLanes.length) {
      toast("Connect at least one provider before sending a prompt.");
      return setView("api");
    }
    state.busy = true;
    for (const lane of state.lanes) { lane.loading = activeLanes.includes(lane); lane.error = ""; }
    $("sendButton").disabled = true;
    $("latestPrompt").textContent = prompt;
    $("promptTime").textContent = "Sending…";
    $("promptInput").value = "";
    renderModels();
    try {
      const result = await api("/api/chat", { method: "POST", body: JSON.stringify({ conversationId: state.conversationId, prompt, models: activeLanes.map(({ provider, model }) => ({ provider, model })) }) });
      state.messages.push({ role: "user", content: prompt, createdAt: new Date().toISOString() });
      for (const response of result.responses) {
        const lane = state.lanes.find((item) => item.provider === response.provider && item.model === response.model);
        if (!lane) continue;
        if (response.status === "ok") {
          lane.error = "";
          lane.turns.push({ role: "user", content: prompt }, { role: "assistant", content: response.content, latencyMs: response.latencyMs, inputTokens: response.usage?.inputTokens, outputTokens: response.usage?.outputTokens });
          state.messages.push({ role: "assistant", provider: response.provider, model: response.model, content: response.content, status: "ok", latencyMs: response.latencyMs, inputTokens: response.usage?.inputTokens, outputTokens: response.usage?.outputTokens, createdAt: new Date().toISOString() });
        } else {
          lane.error = response.error;
          state.messages.push({ role: "assistant", provider: response.provider, model: response.model, content: response.error, status: "error", createdAt: new Date().toISOString() });
        }
        lane.loading = false;
      }
      $("promptTime").textContent = new Date().toLocaleString();
      await loadConversations();
      await loadDashboard();
      renderModels();
    } catch (error) {
      for (const lane of activeLanes) { lane.loading = false; lane.error ||= error.message; }
      toast(error.message);
      renderModels();
    } finally {
      state.busy = false;
      $("sendButton").disabled = false;
    }
  });
  $("promptInput").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      $("chatForm").requestSubmit();
    }
  });

  async function boot() {
    try {
      const result = await api("/api/auth/me");
      if (!result.user) return showAuth();
      state.user = result.user;
      await loadWorkspace();
    } catch (error) {
      showAuth(error.message);
    }
  }

  boot();
})();