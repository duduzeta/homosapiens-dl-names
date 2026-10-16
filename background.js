// Service worker: intercepta downloads e pede um nome descritivo ao modelo.

// Provedores conhecidos. `api` é o formato do wire: "openai" (POST /chat/completions, compatível
// com a maioria dos provedores) ou "anthropic" (POST /messages). `thinking` diz como mapear o
// toggle de "thinking" para aquele provedor (parâmetros desconhecidos dão 400 na OpenAI, então
// só mandamos o que cada um entende). `needsKey: false` permite servidores locais sem chave.
// `keyUrl` é onde o usuário pega a chave; `models` são sugestões para o campo de modelo; `note` é uma dica extra.
const PROVIDERS = {
  groq: {
    label: "Groq — rápido, tem plano grátis",
    api: "openai",
    baseUrl: "https://api.groq.com/openai/v1",
    model: "openai/gpt-oss-120b",
    models: ["openai/gpt-oss-120b", "openai/gpt-oss-20b", "llama-3.3-70b-versatile", "llama-3.1-8b-instant"],
    keyUrl: "https://console.groq.com/keys",
    note: "Se der \"model not found\", o modelo está desligado na sua conta: use outro da lista.",
    thinking: "groq",
  },
  gemini: {
    label: "Google Gemini — tem plano grátis",
    api: "openai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "gemini-2.5-flash",
    models: ["gemini-2.5-flash", "gemini-2.5-flash-lite"],
    keyUrl: "https://aistudio.google.com/apikey",
    note: "No plano grátis o Google pode usar o conteúdo enviado para treinar modelos.",
    thinking: "gemini",
  },
  openai: {
    label: "OpenAI",
    api: "openai",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4.1-mini",
    models: ["gpt-4.1-mini", "gpt-4.1-nano"],
    keyUrl: "https://platform.openai.com/api-keys",
    thinking: "reasoning_effort",
  },
  anthropic: {
    label: "Anthropic (Claude)",
    api: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    model: "claude-haiku-4-5",
    models: ["claude-haiku-4-5", "claude-sonnet-4-5"],
    keyUrl: "https://console.anthropic.com/settings/keys",
    thinking: "anthropic",
  },
  zai: {
    label: "z.ai (GLM)",
    api: "openai",
    baseUrl: "https://api.z.ai/api/paas/v4",
    model: "glm-4.5-air",
    models: ["glm-4.5-air", "glm-4.5-flash", "glm-4.7"],
    keyUrl: "https://z.ai/manage-apikey/apikey-list",
    note: "Coding Plan: use a Base URL https://api.z.ai/api/coding/paas/v4",
    thinking: "glm",
  },
  openrouter: {
    label: "OpenRouter",
    api: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "google/gemini-2.5-flash",
    keyUrl: "https://openrouter.ai/keys",
    thinking: "openrouter",
  },
  deepseek: { label: "DeepSeek", api: "openai", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat", keyUrl: "https://platform.deepseek.com/api_keys", thinking: null },
  mistral: { label: "Mistral", api: "openai", baseUrl: "https://api.mistral.ai/v1", model: "mistral-small-latest", keyUrl: "https://console.mistral.ai/api-keys", thinking: null },
  ollama: { label: "Ollama (local, sem chave)", api: "openai", baseUrl: "http://localhost:11434/v1", model: "llama3.2", thinking: null, needsKey: false },
  lmstudio: { label: "LM Studio (local, sem chave)", api: "openai", baseUrl: "http://localhost:1234/v1", model: "", thinking: null, needsKey: false },
  custom: { label: "Outro (compatível com OpenAI)", api: "openai", baseUrl: "", model: "", thinking: null, needsKey: false },
};

const DEFAULTS = {
  enabled: true,
  provider: "groq",
  apiKey: "",
  apiKeys: {}, // uma chave por provedor; `apiKey` é sempre a do provedor ativo
  baseUrl: PROVIDERS.groq.baseUrl,
  model: PROVIDERS.groq.model,
  timeoutMs: 3000,
  maxLength: 90,
  thinking: false,
  // espera máxima entre o download começar e o nome ser decidido; estourou → nome alternativo montado na hora
  deadlineMs: 3000,
  // chama o modelo já no hover de links/botões com cara de download (o nome fica pronto antes do clique)
  hoverPrefetch: false,
  style:
    "Nomes descritivos e curtos, em Title Case com espaços, no mesmo idioma do conteúdo da página. " +
    "Inclua o que o arquivo é, de quem/de onde vem e uma data/versão quando fizer sentido. " +
    "Ex.: 'Nota Fiscal Acme - Março 2024', 'Contrato de Aluguel - Apto 42', 'Relatório Anual Tesla 2023'.",
};

const HISTORY_LIMIT = 500;

// Abre as configurações ao clicar no ícone.
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  handleDownload(item)
    .then(({ name, log, settle }) => {
      // responde primeiro (é isso que destrava o prompt de salvar); o histórico grava depois
      if (name) suggest({ filename: name, conflictAction: "uniquify" });
      else suggest();
      // espera a chamada ao modelo terminar (mesmo se perdeu o prazo) pra registrar quanto ela levou
      if (log) Promise.resolve(settle).finally(() => pushHistory(log).catch(() => {}));
    })
    .catch((err) => {
      console.warn("[dl-names] erro:", err);
      suggest();
    });
  return true; // vamos chamar suggest() de forma assíncrona
});

function isConfigured(settings) {
  if (!settings.enabled || !settings.baseUrl) return false;
  return !!settings.apiKey || providerOf(settings).needsKey === false;
}

async function handleDownload(item) {
  const t0 = Date.now();
  const settings = await getSettings();
  if (!isConfigured(settings)) return { name: null };

  const original = basename(item.filename || "");
  const ext = extensionOf(original);
  const spec = takeSpec(item, t0);

  // Contexto: o que o content.js mandou no hover/pointerdown; sem isso, coleta agora (mais lento).
  let ctx = spec ? spec.ctx : null;
  let job;
  let source;
  if (spec && spec.job) {
    job = spec.job;
    source = spec.job.done ? "pronto" : "adiantado";
  } else if (isRateLimited()) {
    // sem cota agora: nem tenta, vai direto pro nome alternativo
    if (!ctx) ctx = await withTimeout(collectContext(item), settings.deadlineMs).catch(() => null);
    job = { startedAt: t0, done: true, doneAt: t0, error: "limite de uso do provedor (429), aguardando liberar", promise: Promise.resolve(null) };
    source = "sem cota";
  } else {
    const ctxPromise = ctx ? Promise.resolve(ctx) : collectContext(item);
    ctxPromise.then((c) => (ctx = c));
    job = startJob(settings, ctxPromise.then((c) => ({ original, ext, item, context: c })));
    source = spec ? "no download" : "no download (sem contexto prévio)";
  }

  const remaining = Math.max(0, t0 + settings.deadlineMs - Date.now());
  const result = await Promise.race([job.promise, sleep(remaining).then(() => "deadline")]);

  let finalName = null;
  if (result && result !== "deadline" && result.filename) {
    finalName = withExt(stripExtension(stripExtension(result.filename, ext), extensionOf(result.guessName || "")), ext, settings.maxLength);
  }
  if (!finalName) {
    // prazo estourado ou erro: nome montado na hora com o que a página mostrou
    finalName = withExt(heuristicName(ctx, item), ext, settings.maxLength);
    source = finalName ? (result === "deadline" ? "alternativo (prazo)" : "alternativo (erro)") : "original";
  }
  const waitMs = Date.now() - t0;

  const log = {
    at: Date.now(),
    ms: waitMs,
    waitMs,
    source,
    headStartMs: t0 - job.startedAt, // > 0: o modelo começou antes do download existir
    original,
    renamed: finalName,
    provider: settings.provider,
    model: settings.model,
    url: item.url,
    page: (ctx && (ctx.tabTitle || ctx.title || ctx.tabUrl)) || "",
  };
  // completa o registro quando o modelo responder (pode ser depois do prazo)
  const settle = job.promise.then((r) => {
    log.llmMs = job.doneAt - job.startedAt;
    log.llmName = r && r.filename;
    log.raw = r && r.raw;
    log.prompt = r && r.prompt;
    log.error = job.error || null;
  });

  return { name: finalName, log, settle: withTimeout(settle, settings.timeoutMs + 1000).catch(() => {}) };
}

function withExt(stem, ext, maxLength) {
  const clean = sanitize(stem || "", maxLength);
  if (!clean) return null;
  return ext ? `${clean}.${ext}` : clean;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Uma chamada ao modelo, com os tempos anotados. `argsPromise` permite começar a contar
// antes do contexto ficar pronto.
function startJob(settings, argsPromise) {
  const job = { startedAt: Date.now(), done: false, doneAt: 0, error: null };
  job.promise = Promise.resolve(argsPromise)
    .then((args) => askModel(settings, args).then((r) => ({ ...r, guessName: args.original })))
    .catch((e) => {
      job.error = String(e && e.message ? e.message : e);
      return null;
    })
    .then((r) => {
      job.done = true;
      job.doneAt = Date.now();
      return r;
    });
  return job;
}

// ---------- especulação ----------
// O content.js manda o contexto no hover (só de elementos com cara de download) e no pointerdown.
// Em sinais fortes o modelo já é chamado ali; quando o download começa, o nome costuma estar pronto.

const SPEC_TTL = 120000; // uma preparação vale 2 min
const PRESS_WINDOW = 20000; // download sem URL conhecida (botão JS) casa com o último pointerdown de até 20 s
const HOVER_MIN_GAP = 3000; // no máximo uma chamada por hover a cada 3 s…
const HOVER_MAX_PER_MIN = 6; // …e 6 por minuto, pra sobrar cota do plano grátis pros downloads de verdade
const specs = new Map(); // URL normalizada (ou chave do pointerdown) → { ctx, job, at, pressedAt }
let hoverCalls = [];

function normUrl(u) {
  if (!u) return "";
  try {
    const x = new URL(u);
    x.hash = "";
    return x.href;
  } catch (_) {
    return String(u);
  }
}

async function prepare(msg, sender) {
  const settings = await getSettings();
  if (!isConfigured(settings)) return;
  const now = Date.now();
  for (const [k, s] of specs) if (now - s.at > SPEC_TTL) specs.delete(k);

  const tab = sender.tab || {};
  const ctx = { ...(msg.ctx || {}), tabTitle: tab.title || "", tabUrl: tab.url || "" };
  const href = normUrl(msg.href);
  const key = href || `el:${tab.id}:${sender.frameId}:${msg.elKey}`;
  let spec = specs.get(key);
  if (!spec) {
    spec = { key, at: now, pressedAt: 0, ctx, job: null };
    specs.set(key, spec);
  }
  spec.at = now;
  spec.ctx = ctx;
  if (msg.reason === "press") spec.pressedAt = now;

  if (spec.job && !spec.job.error) return; // já está pronto ou a caminho
  if (!msg.strong || isRateLimited()) {
    warmUp().catch(() => {}); // sem cara de download: guarda só o contexto e aquece a conexão
    return;
  }
  if (msg.reason === "hover") {
    if (!settings.hoverPrefetch) return warmUp().catch(() => {});
    hoverCalls = hoverCalls.filter((t) => now - t < 60000);
    const last = hoverCalls[hoverCalls.length - 1] || 0;
    if (now - last < HOVER_MIN_GAP || hoverCalls.length >= HOVER_MAX_PER_MIN) return warmUp().catch(() => {});
    hoverCalls.push(now);
  }
  const guess = ctx.guessName || "";
  spec.job = startJob(settings, { original: guess, ext: extensionOf(guess), item: { url: href }, context: ctx, speculative: true });
}

// Acha (e consome) a preparação deste download: pela URL; senão, o pointerdown mais recente.
function takeSpec(item, now) {
  let found = null;
  for (const u of [item.url, item.finalUrl]) {
    const s = specs.get(normUrl(u));
    if (s && now - s.at < SPEC_TTL) {
      found = s;
      break;
    }
  }
  if (!found) {
    for (const s of specs.values()) {
      if (s.pressedAt && now - s.pressedAt < PRESS_WINDOW && (!found || s.pressedAt > found.pressedAt)) found = s;
    }
  }
  if (found) specs.delete(found.key);
  return found;
}

// ---------- nome alternativo (sem modelo) ----------
// Quando o modelo não responde no prazo: junta o que identifica o arquivo na página,
// ex. "Fatura #8813 - Março 2024 - Acme Cloud". Melhor que "download (3).pdf".

const GENERIC_WORDS =
  /\b(download|downloads|baixar|baixe|descarregar|exportar|export|salvar|save|clique aqui|click here|aqui|here|arquivo|file|abrir|open|ver|view|obter|get|pdf|csv|xlsx?|docx?|zip)\b/gi;

function heuristicName(ctx, item) {
  if (!ctx) return null;
  const click = ctx.click || {};
  const tidy = (s) => String(s || "").replace(/\s+/g, " ").trim().slice(0, 60).trim();
  const label = tidy(String(click.text || ctx.linkText || "").replace(GENERIC_WORDS, " ")).replace(/^[\s\-–—:·|]+|[\s\-–—:·|]+$/g, "");
  // primeiro pedaço da linha/card ("Fatura #8813 · Plano Pro · …" → "Fatura #8813")
  const row = tidy(String(click.container || "").split(/\s*[·•|\n\t]\s*|\s{2,}/).find((p) => p.trim().length >= 3) || "");
  const heading = tidy(click.heading);
  const [titleCore, titleSite] = splitTitle(ctx.title || ctx.tabTitle || "");
  const site = titleSite || siteName(ctx.tabUrl || (item && (item.referrer || item.url)));

  const parts = [];
  const add = (p) => {
    if (!p || p.length < 3) return;
    const low = p.toLowerCase();
    if (parts.some((q) => q.toLowerCase().includes(low) || low.includes(q.toLowerCase()))) return;
    parts.push(p);
  };
  add(row && row !== click.text ? row : "");
  add(label);
  add(heading);
  if (parts.length < 2) add(titleCore);
  if (!parts.length) return null;
  add(site);
  return parts.slice(0, 3).join(" - ");
}

function splitTitle(title) {
  const m = String(title).match(/^(.*?)\s+[|—–-]\s+([^|—–-]+)$/);
  return m ? [m[1].trim(), m[2].trim()] : [String(title).trim(), ""];
}

function siteName(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    if (!host || host === "localhost" || /^[\d.]+$/.test(host)) return "";
    const label = host.split(".").slice(-2)[0];
    return label.charAt(0).toUpperCase() + label.slice(1);
  } catch (_) {
    return "";
  }
}

// ---------- contexto ----------

async function collectContext(item) {
  const ctx = { tabTitle: "", tabUrl: "", referrer: item.referrer || "" };
  let tab = null;
  try {
    const [tabs, [active]] = await Promise.all([
      item.referrer ? chrome.tabs.query({}) : [],
      chrome.tabs.query({ active: true, lastFocusedWindow: true }),
    ]);
    if (item.referrer) {
      tab =
        tabs.find((t) => t.url === item.referrer) ||
        tabs.find((t) => t.url && sameOrigin(t.url, item.referrer));
    }
    if (!tab) tab = active || null;
  } catch (e) {
    console.warn("[dl-names] tabs.query falhou:", e);
  }
  if (!tab) return ctx;

  ctx.tabTitle = tab.title || "";
  ctx.tabUrl = tab.url || "";

  try {
    // páginas pesadas/travadas não podem segurar o download: sem resposta em 250 ms, segue sem o extra
    const results = await withTimeout(
      chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        func: extractPageInfo,
        args: [item.url || "", item.finalUrl || ""],
      }),
      250
    );
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
  // innerText do corpo inteiro força layout e pode levar centenas de ms em páginas grandes;
  // percorre só os nós de texto até juntar o suficiente.
  let bodySnippet = "";
  try {
    const mainEl = document.querySelector("main, article, [role=main]") || document.body;
    if (mainEl) {
      const skip = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|SVG)$/i;
      const walker = document.createTreeWalker(mainEl, NodeFilter.SHOW_TEXT, {
        acceptNode: (n) => (n.parentElement && skip.test(n.parentElement.tagName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
      });
      const parts = [];
      let len = 0;
      for (let n = walker.nextNode(); n && len < 1200; n = walker.nextNode()) {
        const t = n.nodeValue.trim();
        if (t) {
          parts.push(t);
          len += t.length + 1;
        }
      }
      bodySnippet = clip(parts.join(" "), 800);
    }
  } catch (_) {}

  return { title: clip(document.title, 200), h1, ogTitle, description, linkText, selection, click, bodySnippet };
}

// ---------- modelo ----------

// Prompt enxuto de propósito: planos grátis limitam tokens por minuto (Groq: 8k/min), então cada
// token a menos é download a mais antes do 429 — e resposta mais rápida.
function buildPrompt(settings, { original, ext, item, context, speculative }) {
  const click = context.click || {};
  const title = context.title || context.tabTitle || "";
  const lines = [
    click.text ? `Clicked: ${click.text}` : null,
    click.container ? `Its row/card: ${click.container}` : click.parent ? `Around it: ${click.parent}` : null,
    click.heading ? `Heading above: ${click.heading}` : null,
    context.linkText && context.linkText !== click.text ? `Link text: ${context.linkText}` : null,
    context.selection ? `Selected text: ${context.selection}` : null,
    title ? `Page title: ${title}` : null,
    context.h1 && context.h1 !== title ? `H1: ${context.h1}` : null,
    context.tabUrl ? `Page URL: ${trunc(context.tabUrl, 150)}` : null,
  ];
  // texto da página só quando o clique não diz o bastante (é a parte mais cara do prompt)
  const thin = !click.container && !click.parent && !context.linkText;
  if (thin && context.description) lines.push(`Description: ${trunc(context.description, 200)}`);
  if (thin && context.bodySnippet) lines.push(`Page text: ${trunc(context.bodySnippet, 500)}`);
  // especulativo = antes do download existir: só dá pra adivinhar o nome pelo link
  lines.push(speculative ? `Filename from link (guess): ${original || "?"}` : `Original filename: ${original || "?"}`);
  lines.push(`Download URL: ${trunc(item.finalUrl || item.url, 200)}`);
  if (!speculative && item.mime) lines.push(`MIME: ${item.mime}`);

  const system =
    "Rename a downloaded file so the name alone says what it is months later: WHAT it is (invoice, contract, report, paper, installer…), " +
    "WHO/WHERE it comes from (company, site, author) and an identifying detail (period, version, id, subject).\n" +
    "Trust, in order: clicked element and its row/card > heading/page title > URL > original filename (often junk ids/hashes; ignore unless descriptive). " +
    "Never invent facts. Drop tracking ids, hashes, slogans, navigation text.\n" +
    `Style: ${settings.style}\n` +
    `Max ${settings.maxLength} chars, no file extension, none of < > : " / \\ | ? *\n` +
    "Examples: 'Download PDF' in row 'Invoice #8813 · Mar 2024' at billing.acme.com → Fatura Acme - #8813 - Março 2024 | " +
    "arXiv 'Attention Is All You Need', 1706.03762.pdf → Attention Is All You Need - Vaswani et al 2017 | " +
    "GitHub release 'Obsidian v1.6.7', Obsidian.1.6.7.exe → Obsidian 1.6.7 Installer Windows\n" +
    'Reply with JSON only: {"filename": "<name>"}';

  return { system, user: lines.filter(Boolean).join("\n") };
}

function providerOf(settings) {
  return PROVIDERS[settings.provider] || PROVIDERS.custom;
}

async function askModel(settings, args) {
  const { system, user } = buildPrompt(settings, args);
  const provider = providerOf(settings);
  // a resposta é curta; a folga é pro raciocínio dos modelos que sempre pensam (gpt-oss), que conta no limite
  const maxTokens = settings.thinking ? 2000 : 500;

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
    case "gemini":
      // o 2.5 Flash pensa por padrão (vários segundos); "none" desliga. O Pro não aceita desligar.
      if (settings.thinking) body.reasoning_effort = "medium";
      else if (!/pro/i.test(settings.model)) body.reasoning_effort = "none";
      break;
    case "groq":
      // gpt-oss sempre raciocina (padrão "medium"); "low" mantém ~0,5 s. Llama não aceita o campo.
      if (/gpt-oss/i.test(settings.model)) body.reasoning_effort = settings.thinking ? "medium" : "low";
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
      if (res.status === 429) noteRateLimit(res.headers.get("retry-after"), text);
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

// Limite de uso estourado (429): até passar, nada de chamadas especulativas e o download
// vai direto pro nome alternativo em vez de esperar o prazo por uma resposta que não vem.
let rateLimitedUntil = 0;
function noteRateLimit(retryAfter, body) {
  let ms = parseFloat(retryAfter) * 1000;
  const m = /try again in (?:(\d+)m)?([\d.]+)(ms|s)/i.exec(body || "");
  if (!(ms > 0) && m) ms = (parseInt(m[1] || "0", 10) * 60 + parseFloat(m[2]) / (m[3] === "ms" ? 1000 : 1)) * 1000;
  rateLimitedUntil = Date.now() + Math.min(Math.max(ms || 0, 2000), 120000);
}
function isRateLimited() {
  return Date.now() < rateLimitedUntil;
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

function providerFromUrl(url) {
  try {
    const origin = new URL(url).origin;
    for (const [id, p] of Object.entries(PROVIDERS)) {
      if (p.baseUrl && new URL(p.baseUrl).origin === origin) return id;
    }
  } catch (_) {}
  return "custom";
}

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms))]);
}

// Configurações ficam em memória enquanto o service worker vive; invalidadas quando mudam.
let settingsPromise = null;
function getSettings() {
  if (!settingsPromise) {
    settingsPromise = chrome.storage.local
      .get("settings")
      .then((stored) => {
        const saved = stored.settings || {};
        const s = { ...DEFAULTS, ...saved };
        // versões antigas não salvavam o provedor: descobre pela Base URL
        if (!saved.provider && saved.baseUrl) s.provider = providerFromUrl(saved.baseUrl);
        s.apiKey = (s.apiKeys && s.apiKeys[s.provider]) || s.apiKey;
        return s;
      })
      .catch((e) => {
        settingsPromise = null;
        throw e;
      });
  }
  return settingsPromise;
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.settings) settingsPromise = null;
});

// Pré-aquecimento: o content.js avisa no pointerdown de links/botões (antes do download começar).
// Isso acorda o service worker, carrega as configurações e abre a conexão TLS com a API,
// que o fetch de verdade reaproveita logo em seguida.
const lastWarm = new Map();
async function warmUp() {
  const settings = await getSettings();
  if (!settings.enabled || !settings.baseUrl) return;
  let origin;
  try {
    origin = new URL(settings.baseUrl).origin;
  } catch (_) {
    return;
  }
  const now = Date.now();
  if (now - (lastWarm.get(origin) || 0) < 20000) return;
  lastWarm.set(origin, now);
  fetch(origin, { method: "HEAD", cache: "no-store" }).catch(() => {});
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
  if (msg && msg.type === "prepare") {
    prepare(msg, _sender).catch((e) => console.warn("[dl-names] prepare:", e));
    return;
  }
  if (msg && msg.type === "warm") {
    warmUp().catch(() => {});
    return;
  }
  if (msg && msg.type === "defaults") {
    sendResponse({ defaults: DEFAULTS, providers: PROVIDERS });
  }
});
