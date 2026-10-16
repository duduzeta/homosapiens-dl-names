// Prepara o nome antes do download existir. Manda ao background o contexto do elemento
// no hover (só de links/botões com cara de download) e no pointerdown (~100 ms antes do click);
// em sinais fortes o background já chama o modelo e o nome fica pronto antes do clique.
// Também registra o último clique em window.__dlNamesLastClick, lido pelo background via
// scripting.executeScript (mesmo isolated world) quando não houve preparação.

(() => {
  const clip = (s, n) => (s || "").replace(/\s+/g, " ").trim().slice(0, n);
  // innerText separa células com tab e blocos com quebra de linha; vira " · " pra não grudar
  const cells = (s, n) => clip((s || "").replace(/\s*[\t\n]+\s*/g, " · "), n);

  const ACTIONABLE = "a[href], button, [role=button], [role=link], input[type=submit], input[type=button], [download]";
  const FILE_EXT =
    /\.(pdf|zip|rar|7z|gz|tgz|bz2|xz|tar|csv|tsv|xlsx?|xlsm|ods|docx?|odt|rtf|pptx?|odp|txt|json|xml|epub|mobi|mp3|wav|flac|m4a|mp4|mov|mkv|avi|webm|png|jpe?g|gif|webp|svg|heic|psd|exe|msi|dmg|pkg|apk|deb|rpm|iso|img|ofx|ics|vcf|torrent)$/i;
  const DOWNLOAD_HREF = /download|export|attachment|\/files?\//i;
  // sem "salvar"/"save": botões de formulário gastariam uma chamada a cada clique
  const DOWNLOAD_WORDS = /\b(download|baixar|baixe|descarregar|exportar|export)\b/i;
  const HOVER_DWELL = 200; // ms parado em cima antes de preparar

  function nearestHeading(el) {
    const headings = Array.from(document.querySelectorAll("h1, h2, h3, h4"));
    let best = null;
    for (const h of headings) {
      // heading que vem antes do elemento no documento (ou o contém)
      const pos = h.compareDocumentPosition(el);
      if (pos & Node.DOCUMENT_POSITION_FOLLOWING || pos & Node.DOCUMENT_POSITION_CONTAINED_BY) best = h;
    }
    return best ? clip(best.innerText, 200) : "";
  }

  function labelOf(el) {
    return clip(
      el.innerText ||
        el.textContent ||
        el.getAttribute("aria-label") ||
        el.getAttribute("title") ||
        el.getAttribute("alt") ||
        el.value,
      200
    );
  }

  function hrefOf(el) {
    const a = el.closest("a[href]");
    return (a && a.href) || el.href || "";
  }

  function describe(el) {
    const container = el.closest("tr, li, article, section, [role=row], [role=listitem], .card, [class*=card], [class*=item], [class*=row]");
    return {
      at: Date.now(),
      text: labelOf(el),
      href: hrefOf(el),
      heading: nearestHeading(el),
      container: container && container !== el ? cells(container.innerText, 400) : "",
      parent: el.parentElement ? cells(el.parentElement.innerText, 300) : "",
    };
  }

  // Nome que o link sugere: atributo download ou último pedaço do caminho.
  function guessName(el) {
    const a = el.closest("[download]");
    const attr = a && a.getAttribute("download");
    if (attr) return attr;
    try {
      const last = new URL(hrefOf(el)).pathname.split("/").pop();
      return last ? decodeURIComponent(last) : "";
    } catch (_) {
      return "";
    }
  }

  // "Cara de download": vale chamar o modelo antes de o download existir.
  function looksLikeDownload(el) {
    if (el.closest("[download]")) return true;
    const href = hrefOf(el);
    if (href && !href.startsWith("javascript:")) {
      try {
        const u = new URL(href);
        if (FILE_EXT.test(u.pathname) || DOWNLOAD_HREF.test(u.pathname + u.search)) return true;
      } catch (_) {}
    }
    const words = [labelOf(el), el.getAttribute("aria-label"), el.getAttribute("title")].filter(Boolean).join(" ");
    return DOWNLOAD_WORDS.test(words);
  }

  // Informações da página: caras de calcular em páginas grandes, então ficam em cache por 3 s.
  let pageCache = null;
  function pageInfo() {
    if (pageCache && Date.now() - pageCache.at < 3000) return pageCache.info;
    const meta = (sel) => {
      const el = document.querySelector(sel);
      return el ? el.getAttribute("content") || "" : "";
    };
    const h1El = document.querySelector("h1");
    let bodySnippet = "";
    try {
      // percorre só os nós de texto até juntar o suficiente (innerText do corpo todo força layout)
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
    const info = {
      title: clip(document.title, 200),
      h1: clip(h1El ? h1El.innerText : "", 200),
      ogTitle: clip(meta('meta[property="og:title"]'), 200),
      description: clip(meta('meta[name="description"]') || meta('meta[property="og:description"]'), 300),
      bodySnippet,
    };
    pageCache = { at: Date.now(), info };
    return info;
  }

  // identifica o elemento entre hover e pointerdown quando não há URL (botões JS)
  const elIds = new WeakMap();
  let nextElId = 1;
  function elKey(el) {
    if (!elIds.has(el)) elIds.set(el, nextElId++);
    return elIds.get(el);
  }

  function send(reason, el) {
    let selection = "";
    try {
      selection = clip(String(window.getSelection()), 300);
    } catch (_) {}
    const click = describe(el);
    const msg = {
      type: "prepare",
      reason,
      strong: looksLikeDownload(el),
      href: click.href,
      elKey: elKey(el),
      ctx: { ...pageInfo(), click, linkText: click.text, selection, guessName: guessName(el) },
    };
    try {
      chrome.runtime.sendMessage(msg).catch(() => {});
    } catch (_) {} // contexto invalidado após recarregar a extensão
  }

  function record(target) {
    if (!(target instanceof Element)) return;
    const el = target.closest(ACTIONABLE) || target;
    window.__dlNamesLastClick = describe(el);
  }

  // hover: prepara depois de HOVER_DWELL parado em cima, uma vez por elemento
  const hovered = new WeakSet();
  let hoverEl = null;
  let hoverTimer = 0;
  document.addEventListener(
    "pointerover",
    (e) => {
      const el = e.target instanceof Element ? e.target.closest(ACTIONABLE) : null;
      if (el === hoverEl) return;
      clearTimeout(hoverTimer);
      hoverEl = el;
      if (!el || hovered.has(el)) return;
      hoverTimer = setTimeout(() => {
        if (hoverEl !== el || !looksLikeDownload(el)) return;
        hovered.add(el);
        send("hover", el);
      }, HOVER_DWELL);
    },
    true
  );

  // pointerdown: intenção quase certa de clicar
  let lastPress = { el: null, at: 0 };
  function press(target) {
    if (!(target instanceof Element)) return;
    const el = target.closest(ACTIONABLE) || target;
    const now = Date.now();
    if (lastPress.el === el && now - lastPress.at < 1000) return;
    lastPress = { el, at: now };
    send("press", el);
  }

  document.addEventListener("pointerdown", (e) => press(e.target), true);
  document.addEventListener("click", (e) => record(e.target), true);
  document.addEventListener("auxclick", (e) => record(e.target), true);
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Enter" || e.key === " ") {
        press(document.activeElement);
        record(document.activeElement);
      }
    },
    true
  );
})();
