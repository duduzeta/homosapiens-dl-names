const FIELDS = ["enabled", "apiKey", "baseUrl", "model", "timeoutMs", "maxLength", "style"];
const $ = (id) => document.getElementById(id);

let DEFAULTS = {};

function readForm() {
  return {
    enabled: $("enabled").checked,
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
  $("apiKey").value = s.apiKey || "";
  $("baseUrl").value = s.baseUrl || "";
  $("model").value = s.model || "";
  $("timeoutMs").value = s.timeoutMs;
  $("maxLength").value = s.maxLength;
  $("style").value = s.style || "";
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
  DEFAULTS = await chrome.runtime.sendMessage({ type: "defaults" });
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
  if (!settings.apiKey) return setStatus("Informe a API key primeiro.", "err");
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

$("save").addEventListener("click", save);
$("test").addEventListener("click", test);
$("reset").addEventListener("click", reset);
$("refresh").addEventListener("click", renderHistory);
$("clear").addEventListener("click", clearHistory);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.history) renderHistory();
});

load();
