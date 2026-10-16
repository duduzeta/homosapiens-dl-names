const $ = (id) => document.getElementById(id);

let DEFAULTS = {};
let PROVIDERS = {};
// chaves de todos os provedores; o campo mostra só a do provedor selecionado
let apiKeys = {};
let currentProvider = "";

function readForm() {
  const provider = $("provider").value;
  const apiKey = $("apiKey").value.trim();
  apiKeys[provider] = apiKey;
  return {
    enabled: $("enabled").checked,
    provider,
    apiKey,
    apiKeys: { ...apiKeys },
    baseUrl: $("baseUrl").value.trim(),
    model: $("model").value.trim(),
    timeoutMs: clamp(parseInt($("timeoutMs").value, 10), 1000, 14000, DEFAULTS.timeoutMs),
    deadlineMs: clamp(parseInt($("deadlineMs").value, 10), 100, 10000, DEFAULTS.deadlineMs),
    hoverPrefetch: $("hoverPrefetch").checked,
    maxLength: clamp(parseInt($("maxLength").value, 10), 20, 200, DEFAULTS.maxLength),
    thinking: $("thinking").checked,
    style: $("style").value.trim(),
  };
}

function fillForm(s) {
  $("enabled").checked = !!s.enabled;
  $("thinking").checked = !!s.thinking;
  $("provider").value = PROVIDERS[s.provider] ? s.provider : DEFAULTS.provider;
  currentProvider = $("provider").value;
  apiKeys = { ...(s.apiKeys || {}) };
  // configurações antigas tinham uma chave só, do provedor que estava salvo
  if (s.apiKey && !apiKeys[s.provider]) apiKeys[s.provider] = s.apiKey;
  $("apiKey").value = apiKeys[currentProvider] || "";
  $("baseUrl").value = s.baseUrl || "";
  $("model").value = s.model || "";
  $("timeoutMs").value = s.timeoutMs;
  $("deadlineMs").value = s.deadlineMs;
  $("hoverPrefetch").checked = !!s.hoverPrefetch;
  $("maxLength").value = s.maxLength;
  $("style").value = s.style || "";
  updateProviderHints();
}

function fillProviderSelect() {
  const sel = $("provider");
  sel.textContent = "";
  for (const [id, p] of Object.entries(PROVIDERS)) {
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = p.label;
    sel.appendChild(opt);
  }
}

// Ao trocar de provedor, preenche URL e modelo com o preset dele.
function onProviderChange() {
  apiKeys[currentProvider] = $("apiKey").value.trim();
  currentProvider = $("provider").value;
  const p = PROVIDERS[currentProvider];
  if (!p) return;
  $("apiKey").value = apiKeys[currentProvider] || "";
  $("baseUrl").value = p.baseUrl;
  $("model").value = p.model;
  updateProviderHints();
}

function updateProviderHints() {
  const p = PROVIDERS[$("provider").value] || {};
  const needsKey = p.needsKey !== false;
  $("apiKeyHint").textContent = needsKey
    ? "Fica salva só neste navegador (chrome.storage.local)."
    : "Opcional para este provedor (servidores locais normalmente não pedem chave).";
  $("apiKey").placeholder = needsKey ? `sua API key do ${p.label ? p.label.split(" ")[0] : "provedor"}` : "(opcional)";
  const link = $("keyLink");
  link.hidden = !p.keyUrl;
  if (p.keyUrl) link.href = p.keyUrl;
  const note = $("providerNote");
  note.hidden = !p.note;
  note.textContent = p.note || "";
  fillModelSelect(p);
  $("modelHint").textContent = p.models || p.model ? "" : "Nome do modelo que o servidor expõe.";
  const thinkingRow = $("thinkingRow");
  thinkingRow.hidden = !p.thinking;
  $("thinkingHint").hidden = !p.thinking;
}

// Select com os modelos sugeridos + "Outro"; o campo de texto só aparece no "Outro".
const OTHER_MODEL = "__other__";
function fillModelSelect(p) {
  const sel = $("modelSelect");
  sel.textContent = "";
  for (const m of p.models || (p.model ? [p.model] : [])) {
    const opt = document.createElement("option");
    opt.value = m;
    opt.textContent = m === p.model ? `${m} (recomendado)` : m;
    sel.appendChild(opt);
  }
  const other = document.createElement("option");
  other.value = OTHER_MODEL;
  other.textContent = "Outro (digitar)";
  sel.appendChild(other);
  const current = $("model").value.trim();
  const known = Array.from(sel.options).some((o) => o.value === current);
  sel.value = known ? current : OTHER_MODEL;
  $("model").hidden = known;
}

function onModelSelectChange() {
  const v = $("modelSelect").value;
  const input = $("model");
  if (v === OTHER_MODEL) {
    input.hidden = false;
    input.focus();
  } else {
    input.value = v;
    input.hidden = true;
  }
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

function clamp(n, min, max, fallback) {
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function setStatus(text, kind) {
  const el = $("status");
  el.textContent = text;
  el.className = kind || "";
}

async function load() {
  const res = await chrome.runtime.sendMessage({ type: "defaults" });
  DEFAULTS = res.defaults;
  PROVIDERS = res.providers;
  fillProviderSelect();
  const { settings = {} } = await chrome.storage.local.get("settings");
  // versões antigas não salvavam o provedor: descobre pela Base URL
  if (!settings.provider && settings.baseUrl) settings.provider = providerFromUrl(settings.baseUrl);
  fillForm({ ...DEFAULTS, ...settings });
  await renderHistory();
}

async function save() {
  const settings = readForm();
  await chrome.storage.local.set({ settings });
  fillForm(settings);
  setStatus("Salvo.", "ok");
  setTimeout(() => setStatus(""), 2000);
}

async function test() {
  const settings = readForm();
  const p = PROVIDERS[settings.provider] || {};
  if (!settings.apiKey && p.needsKey !== false) return setStatus("Informe a API key primeiro.", "err");
  if (!settings.baseUrl) return setStatus("Informe a Base URL.", "err");
  setStatus("Testando…");
  $("test").disabled = true;
  try {
    const res = await chrome.runtime.sendMessage({ type: "test", settings });
    if (res && res.ok) setStatus(`OK em ${res.ms} ms → "${res.name}"${res.what ? ` (${res.what})` : ""}`, "ok");
    else setStatus(`Falhou: ${(res && res.error) || "sem resposta"}`, "err");
  } catch (e) {
    setStatus(`Falhou: ${e.message || e}`, "err");
  } finally {
    $("test").disabled = false;
  }
}

async function reset() {
  readForm(); // guarda a chave digitada antes de trocar o provedor
  fillForm({ ...DEFAULTS, apiKeys });
  setStatus("Padrões restaurados (não salvos ainda).");
}

async function renderHistory() {
  const { history = [] } = await chrome.storage.local.get("history");
  const tbody = $("history").querySelector("tbody");
  tbody.textContent = "";
  $("empty").hidden = history.length > 0;
  for (const h of history) {
    const tr = document.createElement("tr");
    const when = new Date(h.at).toLocaleString();
    const cells = [
      when,
      h.original || "",
      h.renamed || (h.error ? `erro: ${h.error}` : "(mantido)"),
      describeSource(h),
      h.model || "—",
      String(h.ms || ""),
    ];
    cells.forEach((text, i) => {
      const td = document.createElement("td");
      td.textContent = text;
      if (i === 4 && h.provider && PROVIDERS[h.provider]) td.title = PROVIDERS[h.provider].label;
      if (i === 2 && h.error) td.className = "err";
      tr.appendChild(td);
    });
    const td = document.createElement("td");
    if (h.prompt) {
      const a = document.createElement("a");
      a.href = "#";
      a.textContent = "contexto";
      a.addEventListener("click", (e) => {
        e.preventDefault();
        const detail = $("detail");
        detail.textContent =
          `PÁGINA: ${h.page || ""}\nURL DO ARQUIVO: ${h.url || ""}\n\n=== CONTEXTO ENVIADO ===\n${h.prompt}\n\n=== RESPOSTA DO MODELO ===\n${h.raw || ""}`;
        detail.hidden = false;
        detail.scrollIntoView({ behavior: "smooth", block: "nearest" });
      });
      td.appendChild(a);
    }
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
}

// "pronto (adiantado 800 ms, modelo 450 ms)" — de onde veio o nome e quanto o modelo levou
function describeSource(h) {
  if (!h.source) return h.what || ""; // registros de versões antigas
  const bits = [];
  if (h.headStartMs > 0) bits.push(`começou ${h.headStartMs} ms antes do download`);
  if (h.llmMs) bits.push(`modelo levou ${h.llmMs} ms`);
  if (h.llmName && h.renamed && !h.renamed.startsWith(h.llmName.replace(/.[a-z0-9]{1,5}$/i, ""))) bits.push(`modelo sugeriu "${h.llmName}"`);
  if (h.error) bits.push(`erro: ${h.error}`);
  return bits.length ? `${h.source} (${bits.join(", ")})` : h.source;
}

async function exportHistory() {
  const { history = [] } = await chrome.storage.local.get("history");
  const blob = new Blob([JSON.stringify(history, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `historico-download-names-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function clearHistory() {
  if (!confirm("Apagar todo o histórico? Exporte antes se quiser guardar.")) return;
  await chrome.storage.local.set({ history: [] });
  await renderHistory();
}

$("provider").addEventListener("change", onProviderChange);
$("modelSelect").addEventListener("change", onModelSelectChange);
$("save").addEventListener("click", save);
$("test").addEventListener("click", test);
$("reset").addEventListener("click", reset);
$("refresh").addEventListener("click", renderHistory);
$("clear").addEventListener("click", clearHistory);
$("export").addEventListener("click", exportHistory);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.history) renderHistory();
});

load();
