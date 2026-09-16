// Service worker: intercepta downloads e pede um nome descritivo ao modelo.

// Provedores conhecidos. `api` é o formato do wire: "openai" (POST /chat/completions, compatível
// com a maioria dos provedores) ou "anthropic" (POST /messages). `thinking` diz como mapear o
// toggle de "thinking" para aquele provedor (parâmetros desconhecidos dão 400 na OpenAI, então
// só mandamos o que cada um entende). `needsKey: false` permite servidores locais sem chave.
const PROVIDERS = {
  zai: { label: "z.ai (GLM)", api: "openai", baseUrl: "https://api.z.ai/api/paas/v4", model: "glm-4.7", thinking: "glm" },
  openai: { label: "OpenAI", api: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-4.1-mini", thinking: "reasoning_effort" },
  anthropic: { label: "Anthropic (Claude)", api: "anthropic", baseUrl: "https://api.anthropic.com/v1", model: "claude-opus-5", thinking: "anthropic" },
  gemini: { label: "Google Gemini", api: "openai", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", model: "gemini-2.5-flash", thinking: "reasoning_effort" },
  openrouter: { label: "OpenRouter", api: "openai", baseUrl: "https://openrouter.ai/api/v1", model: "google/gemini-2.5-flash", thinking: "openrouter" },
  groq: { label: "Groq", api: "openai", baseUrl: "https://api.groq.com/openai/v1", model: "llama-3.3-70b-versatile", thinking: null },
  deepseek: { label: "DeepSeek", api: "openai", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat", thinking: null },
  mistral: { label: "Mistral", api: "openai", baseUrl: "https://api.mistral.ai/v1", model: "mistral-small-latest", thinking: null },
  ollama: { label: "Ollama (local)", api: "openai", baseUrl: "http://localhost:11434/v1", model: "llama3.2", thinking: null, needsKey: false },
  lmstudio: { label: "LM Studio (local)", api: "openai", baseUrl: "http://localhost:1234/v1", model: "", thinking: null, needsKey: false },
  custom: { label: "Outro (compatível com OpenAI)", api: "openai", baseUrl: "", model: "", thinking: null, needsKey: false },
};

const DEFAULTS = {
  enabled: true,
  provider: "zai",
  apiKey: "",
  baseUrl: PROVIDERS.zai.baseUrl,
  model: PROVIDERS.zai.model,
  timeoutMs: 12000,
  maxLength: 90,
  thinking: false,
  style:
    "Nomes descritivos e curtos, em Title Case com espaços, no mesmo idioma do conteúdo da página. " +
    "Inclua o que o arquivo é, de quem/de onde vem e uma data/versão quando fizer sentido. " +
    "Ex.: 'Nota Fiscal Acme - Março 2024', 'Contrato de Aluguel - Apto 42', 'Relatório Anual Tesla 2023'.",
};

const HISTORY_LIMIT = 30;

// Abre as configurações ao clicar no ícone.
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  handleDownload(item)
    .then((name) => {
      if (name) suggest({ filename: name, conflictAction: "uniquify" });
      else suggest();
    })
    .catch((err) => {
      console.warn("[dl-names] erro:", err);
      suggest();
    });
  return true; // vamos chamar suggest() de forma assíncrona
});

async function handleDownload(item) {
  const settings = await getSettings();
  if (!settings.enabled) return null;
  if (!settings.apiKey && providerOf(settings).needsKey !== false) {
    console.warn("[dl-names] API key não configurada.");
    return null;
  }
  if (!settings.baseUrl) {
    console.warn("[dl-names] Base URL não configurada.");
    return null;
  }

  const original = basename(item.filename || "");
  const ext = extensionOf(original);
  const context = await collectContext(item);

  const started = Date.now();
  let result = null;
  let error = null;
  try {
    result = await askModel(settings, { original, ext, item, context });
  } catch (e) {
    error = String(e && e.message ? e.message : e);
  }

  let finalName = null;
  if (result && result.filename) {
    const clean = sanitize(stripExtension(result.filename, ext), settings.maxLength);
    if (clean) finalName = ext ? `${clean}.${ext}` : clean;
  }

  await pushHistory({
    at: Date.now(),
    ms: Date.now() - started,
    original,
    renamed: finalName,
    url: item.url,
    page: context.tabTitle || context.tabUrl || "",
    what: result && result.what,
    raw: result && result.raw,
    prompt: result && result.prompt,
    error,
  });

  return finalName;
}

// ---------- contexto ----------

async function collectContext(item) {
  const ctx = { tabTitle: "", tabUrl: "", referrer: item.referrer || "" };
  let tab = null;
  try {
    const tabs = await chrome.tabs.query({});
    if (item.referrer) {
      tab =
        tabs.find((t) => t.url === item.referrer) ||
        tabs.find((t) => t.url && sameOrigin(t.url, item.referrer));
    }
    if (!tab) {
      const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      tab = active || null;
    }
  } catch (e) {
    console.warn("[dl-names] tabs.query falhou:", e);
  }
  if (!tab) return ctx;

  ctx.tabTitle = tab.title || "";
  ctx.tabUrl = tab.url || "";

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: extractPageInfo,
      args: [item.url || "", item.finalUrl || ""],
    });
    // frame principal dá título/descrição; o clique mais recente pode estar em um iframe
    const main = results.find((r) => r.frameId === 0) || results[0];
    if (main && main.result) Object.assign(ctx, main.result);
    let click = null;
    for (const r of results) {
      const c = r && r.result && r.result.click;
      if (c && (!click || c.at > click.at)) click = c;
    }
    ctx.click = click;
  } catch (e) {
    // páginas internas (brave://, chrome://), PDFs, etc. — segue sem o extra.
  }
  return ctx;
}

// Roda dentro da página. Não pode referenciar nada de fora.
function extractPageInfo(downloadUrl, finalUrl) {
  const clip = (s, n) => (s || "").replace(/\s+/g, " ").trim().slice(0, n);
  const meta = (sel) => {
    const el = document.querySelector(sel);
    return el ? el.getAttribute("content") || "" : "";
  };

  let linkText = "";
  try {
    const targets = new Set([downloadUrl, finalUrl].filter(Boolean));
    for (const a of document.querySelectorAll("a[href]")) {
      if (targets.has(a.href)) {
        linkText = clip(a.innerText || a.textContent || a.getAttribute("title") || a.getAttribute("aria-label"), 200);
        if (linkText) break;
      }
    }
  } catch (_) {}

  let selection = "";
  try {
    selection = clip(String(window.getSelection()), 300);
  } catch (_) {}

  // último clique registrado pelo content.js (só vale se foi recente)
  let click = null;
  try {
    const c = window.__dlNamesLastClick;
    if (c && Date.now() - c.at < 90000) click = c;
  } catch (_) {}

  const h1El = document.querySelector("h1");
  const h1 = clip(h1El ? h1El.innerText : "", 200);
  const description = clip(meta('meta[name="description"]') || meta('meta[property="og:description"]'), 300);
  const ogTitle = clip(meta('meta[property="og:title"]'), 200);
  const mainEl = document.querySelector("main, article, [role=main]") || document.body;
  const bodySnippet = clip(mainEl ? mainEl.innerText : "", 800);

  return { title: clip(document.title, 200), h1, ogTitle, description, linkText, selection, click, bodySnippet };
}

// ---------- modelo ----------

function buildPrompt(settings, { original, ext, item, context }) {
  const click = context.click || {};
  const sections = [];

  const strong = [
    click.text ? `Clicked element text: ${click.text}` : null,
    click.heading ? `Nearest heading above the clicked element: ${click.heading}` : null,
    click.container ? `Text of the row/card containing the clicked element: ${click.container}` : null,
    !click.container && click.parent ? `Text around the clicked element: ${click.parent}` : null,
    context.linkText && context.linkText !== click.text ? `Text of the link matching the download URL: ${context.linkText}` : null,
    context.selection ? `Text selected on the page: ${context.selection}` : null,
  ].filter(Boolean);
  if (strong.length) sections.push("## What the user clicked (strongest signal)\n" + strong.join("\n"));

  const page = [
    context.title || context.tabTitle ? `Page title: ${context.title || context.tabTitle}` : null,
    context.h1 && context.h1 !== (context.title || context.tabTitle) ? `H1: ${context.h1}` : null,
    context.ogTitle && context.ogTitle !== (context.title || context.tabTitle) ? `OG title: ${context.ogTitle}` : null,
    context.description ? `Meta description: ${context.description}` : null,
    context.tabUrl ? `Page URL: ${trunc(context.tabUrl, 300)}` : null,
    context.bodySnippet ? `Main content (start): ${context.bodySnippet}` : null,
  ].filter(Boolean);
  if (page.length) sections.push("## Page the download came from\n" + page.join("\n"));

  const file = [
    `Original filename: ${original || "(none)"}`,
    `Extension: ${ext || "(none)"}`,
    `Download URL: ${trunc(item.finalUrl || item.url, 400)}`,
    item.mime ? `MIME: ${item.mime}` : null,
    item.fileSize > 0 ? `Size: ${item.fileSize} bytes` : null,
    context.referrer && context.referrer !== context.tabUrl ? `Referrer: ${trunc(context.referrer, 300)}` : null,
  ].filter(Boolean);
  sections.push("## The file\n" + file.join("\n"));

  const system =
    "You are a meticulous assistant that renames downloaded files the way a tidy human would, " +
    "so that months later the name alone tells what the file is.\n\n" +
    "How to decide the name:\n" +
    "1. First work out WHAT the file is (an invoice, a contract, a paper, a photo, a dataset, an installer, a receipt…), " +
    "WHO/WHERE it comes from (company, author, product, site) and any identifying detail (period, version, subject, id).\n" +
    "2. Signal priority: the clicked element and the text around it > page headings/title > URL path > original filename. " +
    "The original filename is often auto-generated junk (ids, hashes, 'download', 'file', 'export') — ignore it unless it is already descriptive.\n" +
    "3. Drop noise: tracking ids, hashes, 'final', 'v2', site slogans, navigation text, cookie banners.\n" +
    "4. Never invent facts. If the context is thin, name it from the URL path and the site name rather than guessing.\n" +
    "5. Keep names that are already good — just tidy them (replace underscores, expand obvious abbreviations).\n\n" +
    "Formatting:\n" +
    `- Style instructions from the user: ${settings.style}\n` +
    `- Max ${settings.maxLength} characters. No path separators, no < > : " / \\ | ? *, no quotes, no file extension.\n\n` +
    "Examples (context → filename):\n" +
    "- Clicked 'Download PDF' on 'Invoice #8813' at billing.acme.com, file inv_8813.pdf → Fatura Acme - #8813 - Março 2024\n" +
    "- Clicked 'Baixar contrato assinado' on 'Contrato de locação — Rua das Flores 120' → Contrato de Locação Assinado - Rua das Flores 120\n" +
    "- arXiv page 'Attention Is All You Need', file 1706.03762.pdf → Attention Is All You Need - Vaswani et al 2017\n" +
    "- Clicked 'Export CSV' on a Stripe dashboard 'Payouts · Jan 2025' → Stripe Payouts - Janeiro 2025\n" +
    "- GitHub release page 'Obsidian v1.6.7', file Obsidian.1.6.7.exe → Obsidian 1.6.7 Installer Windows\n\n" +
    'Respond with JSON only: {"what": "<one short sentence: what the file is and where it comes from>", "filename": "<the name>"}';

  return { system, user: sections.join("\n\n") };
}

function providerOf(settings) {
  return PROVIDERS[settings.provider] || PROVIDERS.custom;
}

async function askModel(settings, args) {
  const { system, user } = buildPrompt(settings, args);
  const provider = providerOf(settings);
  const maxTokens = settings.thinking ? 2000 : 300;

  const req =
    provider.api === "anthropic"
      ? anthropicRequest(settings, provider, { system, user, maxTokens })
      : openaiRequest(settings, provider, { system, user, maxTokens });

  const data = await postJson(req, settings.timeoutMs);
  const content = provider.api === "anthropic" ? anthropicText(data) : openaiText(data);
  const parsed = parseFilename(content);
  return { ...parsed, raw: content, prompt: user };
}

// ---- wire "openai": /chat/completions (z.ai, OpenAI, Gemini, OpenRouter, Groq, Ollama, …)

function openaiRequest(settings, provider, { system, user, maxTokens }) {
  const body = {
    model: settings.model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: 0.2,
    max_tokens: maxTokens,
  };
  // Cada provedor tem um jeito de ligar o "thinking"; campos desconhecidos dão 400 em alguns.
  switch (provider.thinking) {
    case "glm":
      body.thinking = { type: settings.thinking ? "enabled" : "disabled" };
      break;
    case "reasoning_effort":
      // só manda quando ligado: modelos sem raciocínio rejeitam o campo
      if (settings.thinking) body.reasoning_effort = "medium";
      break;
    case "openrouter":
      if (settings.thinking) body.reasoning = { effort: "medium" };
      break;
  }
  const headers = { "Content-Type": "application/json" };
  if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;
  return { url: `${settings.baseUrl.replace(/\/+$/, "")}/chat/completions`, headers, body };
}

function openaiText(data) {
  const msg = data && data.choices && data.choices[0] && data.choices[0].message;
  return (msg && msg.content) || "";
}

// ---- wire "anthropic": /messages

function anthropicRequest(settings, provider, { system, user, maxTokens }) {
  const body = {
    model: settings.model,
    system,
    messages: [{ role: "user", content: user }],
    max_tokens: maxTokens,
  };
  const legacyThinking = /claude-(3|haiku-4-5|sonnet-4-5|opus-4-5)/.test(settings.model);
  if (settings.thinking) {
    // Modelos 4.6+ usam thinking adaptativo; Haiku 4.5 e anteriores ainda usam budget_tokens.
    body.thinking = legacyThinking ? { type: "enabled", budget_tokens: 1024 } : { type: "adaptive" };
    if (legacyThinking) body.max_tokens = Math.max(maxTokens, 1500);
  } else if (!legacyThinking) {
    // Opus 5 pensa por padrão; effort baixo mantém a resposta rápida sem desligar o thinking.
    body.output_config = { effort: "low" };
  }
  const headers = {
    "Content-Type": "application/json",
    "x-api-key": settings.apiKey,
    "anthropic-version": "2023-06-01",
    // A chave é do próprio usuário e fica só no storage local da extensão.
    "anthropic-dangerous-direct-browser-access": "true",
  };
  return { url: `${settings.baseUrl.replace(/\/+$/, "")}/messages`, headers, body };
}

function anthropicText(data) {
  const blocks = (data && data.content) || [];
  return blocks
    .filter((b) => b && b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

async function postJson({ url, headers, body }, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: controller.signal });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

function parseFilename(content) {
  if (!content) return { filename: null, what: null };
  let text = String(content).trim();
  // remove cercas de código
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  const m = text.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const obj = JSON.parse(m[0]);
      if (obj && typeof obj.filename === "string") {
        return { filename: obj.filename.trim(), what: typeof obj.what === "string" ? obj.what.trim() : null };
      }
    } catch (_) {}
  }
  // fallback: primeira linha não vazia
  const line = text.split("\n").map((l) => l.trim()).find(Boolean) || "";
  return { filename: line.replace(/^["'`]+|["'`]+$/g, "").trim() || null, what: null };
}

// ---------- utilidades ----------

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

function sanitize(name, maxLength) {
  let s = String(name || "")
    .replace(/[\x00-\x1f\x7f<>:"/\\|?*]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "")
    .replace(/^[. ]+/g, "");
  if (s.length > maxLength) s = s.slice(0, maxLength).trim().replace(/[. ]+$/g, "");
  if (!s || WINDOWS_RESERVED.test(s)) return "";
  return s;
}

function stripExtension(name, ext) {
  if (!ext) return name;
  const re = new RegExp(`\\.${escapeRegExp(ext)}$`, "i");
  return String(name).replace(re, "");
}

function basename(path) {
  return String(path).split(/[\\/]/).pop() || "";
}

function extensionOf(filename) {
  const lower = filename.toLowerCase();
  // extensões duplas comuns
  for (const dbl of ["tar.gz", "tar.bz2", "tar.xz"]) {
    if (lower.endsWith("." + dbl)) return dbl;
  }
  const m = filename.match(/\.([a-z0-9]{1,10})$/i);
  return m ? m[1].toLowerCase() : "";
}

function sameOrigin(a, b) {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch (_) {
    return false;
  }
}

function trunc(s, n) {
  s = String(s || "");
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function getSettings() {
  const stored = await chrome.storage.local.get("settings");
  return { ...DEFAULTS, ...(stored.settings || {}) };
}

async function pushHistory(entry) {
  const { history = [] } = await chrome.storage.local.get("history");
  history.unshift(entry);
  await chrome.storage.local.set({ history: history.slice(0, HISTORY_LIMIT) });
}

// Permite que a página de opções teste a conexão.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "test") {
    (async () => {
      const settings = { ...DEFAULTS, ...(msg.settings || {}) };
      const started = Date.now();
      try {
        const r = await askModel(settings, {
          original: "download.pdf",
          ext: "pdf",
          item: { url: "https://billing.acme.com/invoices/8813/download?token=abc123", mime: "application/pdf" },
          context: {
            tabTitle: "Faturas — Acme Cloud",
            title: "Faturas — Acme Cloud",
            tabUrl: "https://billing.acme.com/invoices",
            h1: "Faturas",
            click: { text: "Baixar PDF", heading: "Março 2024", container: "Fatura #8813 · Plano Pro · R$ 149,00 · Paga em 05/03/2024 · Baixar PDF" },
          },
        });
        sendResponse({ ok: true, name: r.filename, what: r.what, ms: Date.now() - started });
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
      }
    })();
    return true;
  }
  if (msg && msg.type === "defaults") {
    sendResponse({ defaults: DEFAULTS, providers: PROVIDERS });
  }
});
