// Registra o último elemento clicado/ativado na página, pra dar contexto ao download.
// O background lê window.__dlNamesLastClick via scripting.executeScript (mesmo isolated world).

(() => {
  const clip = (s, n) => (s || "").replace(/\s+/g, " ").trim().slice(0, n);

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

  function record(target) {
    if (!(target instanceof Element)) return;
    const el = target.closest("a, button, [role=button], [role=link], input[type=submit], input[type=button], [download]") || target;
    const container = el.closest("tr, li, article, section, [role=row], [role=listitem], .card, [class*=card], [class*=item], [class*=row]");
    window.__dlNamesLastClick = {
      at: Date.now(),
      text: labelOf(el),
      href: el.href || (el.closest("a") && el.closest("a").href) || "",
      heading: nearestHeading(el),
      container: container && container !== el ? clip(container.innerText, 400) : "",
      parent: el.parentElement ? clip(el.parentElement.innerText, 300) : "",
    };
  }

  document.addEventListener("click", (e) => record(e.target), true);
  document.addEventListener("auxclick", (e) => record(e.target), true);
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Enter" || e.key === " ") record(document.activeElement);
    },
    true
  );
})();
