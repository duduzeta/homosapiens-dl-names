const $ = (id) => document.getElementById(id);

let DEFAULTS = {};
let PROVIDERS = {};

function readForm() {
  return {
    enabled: $("enabled").checked,
    provider: $("provider").value,
    apiKey: $("apiKey").value.trim(),
    baseUrl: $("baseUrl").value.trim(),
    model: $("model").value.trim(),
    timeoutMs: clamp(parseInt($("timeoutMs").value, 10), 1000, 14000, DEFAULTS.timeoutMs),
    maxLength: clamp(parseInt($("maxLength").value, 10), 20, 200, DEFAULTS.maxLength),
    thinking: $("thinking").checked,
    style: $("style").value.trim(),
  };
}

function fillForm(s) {
  $("enabled").checked = !!s.enabled;
  $("thinking").checked = !!s.thinking;
  $("provider").value = PROVIDERS[s.provider] ? s.provider : DEFAULTS.provider;
  $("apiKey").value = s.apiKey || "";
  $("baseUrl").value = s.baseUrl || "";
  $("model").value = s.model || "";
  $("timeoutMs").value = s.timeoutMs;
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
  const p = PROVIDERS[$("provider").value];
  if (!p) return;
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
  $("apiKey").placeholder = needsKey ? "sua API key" : "(opcional)";
  $("modelHint").textContent = p.model ? `Sugerido: ${p.model}` : "Nome do modelo que o servidor expõe.";
  const thinkingRow = $("thinkingRow");
  thinkingRow.hidden = !p.thinking;
  $("thinkingHint").hidden = !p.thinking;
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
  const apiKey = $("apiKey").value;
  fillForm({ ...DEFAULTS, apiKey });
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
      h.what || "",
      String(h.ms || ""),
    ];
    cells.forEach((text, i) => {
      const td = document.createElement("td");
      td.textContent = text;
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

async function clearHistory() {
  await chrome.storage.local.set({ history: [] });
  await renderHistory();
}

$("provider").addEventListener("change", onProviderChange);
$("save").addEventListener("click", save);
$("test").addEventListener("click", test);
$("reset").addEventListener("click", reset);
$("refresh").addEventListener("click", renderHistory);
$("clear").addEventListener("click", clearHistory);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.history) renderHistory();
});

load();
