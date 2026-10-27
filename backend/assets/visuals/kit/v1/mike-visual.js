(function () {
  "use strict";

  const SVG_NS = "http://www.w3.org/2000/svg";

  function theme() {
    const attr = document.documentElement.getAttribute("data-theme");
    if (attr === "dark" || attr === "light") return attr;
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  function onThemeChange(fn) {
    new MutationObserver(fn).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    if (window.matchMedia) window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", fn);
  }

  // The host page (if any) is the parent frame. A downloaded file has none,
  // and then the bridge does nothing at all.
  const host = window.parent !== window ? window.parent : null;
  const CITE_KEYS = ["cite", "citeVersion", "page", "quote", "sheet", "cell", "clause"];
  function post(message) {
    if (host) host.postMessage(message, "*");
  }
  function postCite(cite) {
    if (!cite || document.documentElement.dataset.mikeCites === "off") return;
    const payload = { type: "mike:cite" };
    for (const k of CITE_KEYS) if (cite[k] != null) payload[k] = String(cite[k]);
    post(payload);
  }
  function activateCite(node) {
    document.querySelectorAll('[data-cite][aria-pressed="true"]').forEach((other) => {
      if (other !== node) other.setAttribute("aria-pressed", "false");
    });
    if (node.tagName === "BUTTON") node.setAttribute("aria-pressed", "true");
    postCite(node.dataset);
  }
  document.addEventListener("click", (e) => {
    const node = e.target.closest && e.target.closest("[data-cite]");
    if (!node) return;
    e.preventDefault();
    activateCite(node);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const node = e.target.closest && e.target.closest("[data-cite]");
    if (!node || node.tagName === "BUTTON" || node.tagName === "A") return;
    e.preventDefault();
    activateCite(node);
  });
  window.addEventListener("message", (e) => {
    if (!host || e.source !== host || !e.data || e.data.type !== "mike:host") return;
    if (e.data.theme === "dark" || e.data.theme === "light") document.documentElement.setAttribute("data-theme", e.data.theme);
    document.documentElement.dataset.mikeCites = e.data.cites === false ? "off" : "on";
  });
  let errorPosted = false;
  function postError() {
    if (errorPosted || document.documentElement.dataset.mvReady) return;
    errorPosted = true;
    post({ type: "mike:error" });
  }
  window.addEventListener("error", postError);
  window.addEventListener("unhandledrejection", postError);

  // Ready: fonts and every graph or chart started before the first layout
  // have drawn, or three seconds have passed. Posted once; export waits on
  // the data attribute.
  const pending = [];
  function track(promise) {
    pending.push(Promise.resolve(promise).catch(() => {}));
    return promise;
  }
  let readyPromise = null;
  function ready() {
    if (readyPromise) return readyPromise;
    readyPromise = new Promise((resolve) => {
      const settle = () => Promise.all(pending.splice(0)).then(() => (pending.length ? settle() : resolve()));
      const start = () => Promise.race([
        fontsReady().then(settle),
        new Promise((r) => setTimeout(r, 3000)),
      ]).then(resolve);
      if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
      else start();
    }).then(() => {
      numberCites(document);
      glueCites(document);
      document.documentElement.dataset.mvReady = "1";
      post({ type: "mike:ready" });
    });
    return readyPromise;
  }
  function data(name) {
    const el = document.getElementById("mv-data-" + name);
    if (!el) throw new Error("MikeVisual.data: no data block named " + name);
    return JSON.parse(el.textContent);
  }
  const EXPORT = document.documentElement.hasAttribute("data-mv-export");
  if (EXPORT) {
    document.addEventListener("DOMContentLoaded", () => {
      document.querySelectorAll("details").forEach((d) => { d.open = true; });
    });
  }
  // A page that never calls ready() still reports once its scripts have run.
  window.addEventListener("load", () => setTimeout(ready, 0));

  const ctx = document.createElement("canvas").getContext("2d");
  function measure(text, font, tracking) {
    ctx.font = font;
    return ctx.measureText(text).width + (tracking ? tracking * text.length : 0);
  }
  function wrap(text, font, max) {
    const words = String(text).split(/\s+/);
    const lines = [];
    let line = "";
    for (const w of words) {
      const next = line ? line + " " + w : w;
      if (line && measure(next, font) > max) { lines.push(line); line = w; } else line = next;
    }
    if (line) lines.push(line);
    return lines;
  }
  function svgEl(name, attrs, parent) {
    const n = document.createElementNS(SVG_NS, name);
    for (const k in attrs) if (attrs[k] != null) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  }
  function htmlEl(tag, cls, text, parent) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    if (parent) parent.appendChild(n);
    return n;
  }
  function setCite(node, cite, fallbackId, label) {
    if (!cite) return;
    for (const k in cite) node.setAttribute("data-" + k.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase()), cite[k]);
    if (!("cite" in cite) && fallbackId != null) node.setAttribute("data-cite", fallbackId);
    node.setAttribute("tabindex", "0");
    node.setAttribute("role", "button");
    if (label) node.setAttribute("aria-label", label);
  }
  function glueCites(root) {
    root.querySelectorAll(".mv-cite").forEach((cite) => {
      const prev = cite.previousSibling;
      if (cite.closest(".mv-nowrap") || !prev || prev.nodeType !== 3) return;
      const m = /(\S+)\s*$/.exec(prev.textContent);
      if (!m) return;
      prev.textContent = prev.textContent.slice(0, m.index);
      const span = htmlEl("span", "mv-nowrap");
      cite.parentNode.insertBefore(span, cite);
      span.append(m[1] + " ", cite);
    });
  }
  // A cite built without a number gets the next one after the page's highest.
  function numberCites(root) {
    const cites = Array.from(root.querySelectorAll(".mv-cite"));
    let n = Math.max(0, ...cites.map((b) => +b.textContent || 0));
    for (const b of cites) if (!/^\d+$/.test(b.textContent.trim())) b.textContent = String(++n);
  }
  // <div class="mv-tabs"><section class="mv-tab" data-tab="Label">…</section>…</div>
  // becomes a tablist. Hidden panels keep their charts, which redraw to the
  // real width when their tab is shown; in export every panel is shown.
  let tabSets = 0;
  // Scrolls only the tablist, never the page, so picking a tab keeps the reader's place.
  function revealTab(list, button) {
    const l = list.getBoundingClientRect();
    const b = button.getBoundingClientRect();
    const pad = parseFloat(getComputedStyle(list).paddingLeft) || 0;
    if (b.left < l.left + pad) list.scrollLeft += b.left - l.left - pad;
    else if (b.right > l.right - pad) list.scrollLeft += b.right - l.right + pad;
  }
  function tabs(root) {
    if (typeof root === "string") root = document.querySelector(root);
    const panels = root && !root.dataset.mvTabs ? Array.from(root.children).filter((el) => el.classList.contains("mv-tab")) : [];
    if (!panels.length) return;
    root.dataset.mvTabs = String(++tabSets);
    const list = htmlEl("div", "mv-tabs-list");
    list.setAttribute("role", "tablist");
    list.setAttribute("aria-label", root.getAttribute("aria-label") || "Views");
    let current = -1;
    const select = (i, focus) => {
      current = i;
      // Show before hiding: a tabindex change flushes layout, and a page with
      // every panel hidden is short enough to clamp the scroll position to 0.
      panels[i].hidden = false;
      buttons.forEach((b, j) => {
        b.setAttribute("aria-selected", String(j === i));
        b.setAttribute("tabindex", j === i ? "0" : "-1");
        if (j !== i) panels[j].hidden = true;
      });
      if (focus) {
        revealTab(list, buttons[i]);
        buttons[i].focus({ preventScroll: true });
      }
    };
    const buttons = panels.map((panel, i) => {
      if (!panel.dataset.tab) panel.dataset.tab = "Tab " + (i + 1);
      const button = htmlEl("button", "mv-tabs-tab", panel.dataset.tab, list);
      button.type = "button";
      button.id = `mv-tab-${tabSets}-${i + 1}`;
      if (!panel.id) panel.id = `mv-tabpanel-${tabSets}-${i + 1}`;
      button.setAttribute("role", "tab");
      button.setAttribute("aria-controls", panel.id);
      panel.setAttribute("role", "tabpanel");
      panel.setAttribute("aria-labelledby", button.id);
      panel.setAttribute("tabindex", "0");
      button.addEventListener("click", () => select(i, true));
      return button;
    });
    list.addEventListener("keydown", (e) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const focused = buttons.indexOf(e.target);
      const from = focused >= 0 ? focused : current;
      const next = { ArrowRight: from + 1, ArrowLeft: from - 1, Home: 0, End: buttons.length - 1 }[e.key];
      if (next === undefined) return;
      e.preventDefault();
      select((next + buttons.length) % buttons.length, true);
    });
    root.insertBefore(list, root.firstChild);
    select(0);
  }
  document.addEventListener("DOMContentLoaded", () => {
    document.querySelectorAll(".mv-tabs").forEach(tabs);
    numberCites(document);
    glueCites(document);
  });
  function fontsReady() {
    if (!document.fonts) return Promise.resolve();
    return Promise.all([
      document.fonts.load('500 15px "EB Garamond"'),
      document.fonts.load('italic 400 15px "EB Garamond"'),
      document.fonts.load('500 12px Inter'),
      document.fonts.ready,
    ]).catch(() => {});
  }
  function roundedPath(pts, r) {
    let d = `M${pts[0].x},${pts[0].y}`;
    for (let i = 1; i < pts.length - 1; i++) {
      const p = pts[i - 1], c = pts[i], n = pts[i + 1];
      const d1 = Math.hypot(c.x - p.x, c.y - p.y), d2 = Math.hypot(n.x - c.x, n.y - c.y);
      if (!d1 || !d2) continue;
      const rr = Math.min(r, d1 / 2, d2 / 2);
      const a = { x: c.x + ((p.x - c.x) / d1) * rr, y: c.y + ((p.y - c.y) / d1) * rr };
      const b = { x: c.x + ((n.x - c.x) / d2) * rr, y: c.y + ((n.y - c.y) / d2) * rr };
      d += ` L${a.x},${a.y} Q${c.x},${c.y} ${b.x},${b.y}`;
    }
    const last = pts[pts.length - 1];
    return d + ` L${last.x},${last.y}`;
  }
  function onWidthChange(target, fn, min) {
    if (!window.ResizeObserver) return;
    let w = target.clientWidth, t;
    new ResizeObserver(() => {
      if (Math.abs(target.clientWidth - w) < (min || 1)) return;
      w = target.clientWidth;
      clearTimeout(t);
      t = setTimeout(fn, 60);
    }).observe(target);
  }
  function innerWidth(node) {
    const cs = getComputedStyle(node);
    return (node.clientWidth || 600) - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  }

  const FONT_LABEL = '500 14.5px "EB Garamond", Georgia, serif';
  const FONT_EYEBROW = '500 9.5px Inter, system-ui, sans-serif';
  const FONT_SUB = '400 11px Inter, system-ui, sans-serif';
  const FONT_EDGE = '500 10.5px Inter, system-ui, sans-serif';
  const EYEBROW_TRACK = 0.76;
  const PAD_X = 12, DECISION_INSET = 12;

  function sizeNode(n, maxText) {
    const extraX = n.kind === "decision" ? DECISION_INSET * 2 : n.kind === "terminal" ? 8 : 0;
    const label = wrap(n.label, FONT_LABEL, maxText);
    const sub = n.sublabel ? wrap(n.sublabel, FONT_SUB, maxText) : [];
    const eyebrow = n.eyebrow ? String(n.eyebrow).toUpperCase() : "";
    const w = Math.max(
      ...label.map((l) => measure(l, FONT_LABEL)),
      ...sub.map((l) => measure(l, FONT_SUB)),
      eyebrow ? measure(eyebrow, FONT_EYEBROW, EYEBROW_TRACK) : 0,
      36
    );
    return {
      label, sub, eyebrow,
      width: Math.ceil(w + PAD_X * 2 + extraX),
      height: 18 + (eyebrow ? 13 : 0) + label.length * 17 + sub.length * 14 + (sub.length ? 1 : 0),
    };
  }

  // Inbound edges each get their own port, spread along the side they enter,
  // so several arrows into one node do not land on top of each other. Outbound
  // edges share one port so a parent's children hang from a single trunk.
  function buildElkGraph(spec, sized, direction, compact) {
    const inSide = direction === "RIGHT" ? "WEST" : "NORTH";
    const outSide = direction === "RIGHT" ? "EAST" : "SOUTH";
    const ports = new Map(spec.nodes.map((n) => [n.id, []]));
    const edges = spec.edges.map((e, i) => {
      const side = e.exit === "side";
      const inPort = `${e.target}__in${i}`;
      const outPort = side ? `${e.source}__side${i}` : `${e.source}__out`;
      ports.get(e.target).push({ id: inPort, width: 1, height: 1, layoutOptions: { "elk.port.side": inSide } });
      if (!ports.get(e.source).some((p) => p.id === outPort)) {
        const portSide = side ? (direction === "RIGHT" ? "SOUTH" : "EAST") : outSide;
        ports.get(e.source).push({ id: outPort, width: 1, height: 1, layoutOptions: { "elk.port.side": portSide } });
      }
      const spine = spec.variant === "flow" && !side;
      return {
        id: "e" + i,
        sources: [outPort],
        targets: [inPort],
        layoutOptions: spine ? { "elk.layered.priority.straightness": "10" } : undefined,
        labels: e.label ? [{ text: e.label, width: Math.ceil(measure(e.label, FONT_EDGE) + 8), height: 15 }] : [],
      };
    });
    return {
      id: "root",
      layoutOptions: {
        "elk.algorithm": "layered",
        "elk.direction": direction,
        "elk.edgeRouting": "ORTHOGONAL",
        "elk.spacing.nodeNode": compact ? "12" : "20",
        "elk.layered.spacing.nodeNodeBetweenLayers": compact ? "26" : "36",
        "elk.layered.spacing.edgeNodeBetweenLayers": "14",
        "elk.layered.spacing.edgeEdgeBetweenLayers": "8",
        "elk.spacing.edgeEdge": "10",
        "elk.spacing.edgeLabel": "3",
        "elk.edgeLabels.placement": "CENTER",
        "elk.layered.mergeEdges": "false",
        "elk.layered.nodePlacement.strategy": spec.variant === "flow" ? "NETWORK_SIMPLEX" : "BRANDES_KOEPF",
        "elk.layered.nodePlacement.bk.fixedAlignment": "BALANCED",
        "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
        "elk.padding": "[top=6,left=6,bottom=6,right=6]",
      },
      children: spec.nodes.map((n) => ({
        id: n.id,
        width: sized.get(n.id).width,
        height: sized.get(n.id).height,
        ports: ports.get(n.id),
        layoutOptions: {
          "elk.portConstraints": "FIXED_SIDE",
          "elk.portAlignment.default": "DISTRIBUTED",
          "elk.spacing.portPort": "14",
        },
      })),
      edges,
    };
  }

  // ELK centres nodes of different heights within a layer; hanging every box
  // in a row from the same top line reads more like a drawn chart.
  function alignLayerTops(out) {
    const shift = new Map();
    let top = null;
    out.children.slice().sort((a, b) => a.y - b.y).forEach((n) => {
      if (top === null || n.y - top > 40) top = n.y;
      shift.set(n.id, { dy: top - n.y, y0: n.y, h: n.height });
      n.y = top;
    });
    const owner = (portId) => portId.split("__")[0];
    out.edges.forEach((e) => {
      const s = e.sections && e.sections[0];
      if (!s) return;
      const src = shift.get(owner(e.sources[0])), tgt = shift.get(owner(e.targets[0]));
      if (src && Math.abs(s.startPoint.y - (src.y0 + src.h)) < 2) {
        s.startPoint.y += src.dy;
        const b = s.bendPoints && s.bendPoints[0];
        if (b && b.y < s.startPoint.y + 6) { s.startPoint.y = Math.min(s.startPoint.y, b.y - 6); }
      }
      if (tgt && Math.abs(s.endPoint.y - tgt.y0) < 2) s.endPoint.y += tgt.dy;
    });
  }

  async function layoutOnce(spec, direction, compact) {
    const maxText = compact ? 100 : 116;
    const sized = new Map(spec.nodes.map((n) => [n.id, sizeNode(n, maxText)]));
    const out = await new ELK().layout(buildElkGraph(spec, sized, direction, compact));
    if (direction === "DOWN") alignLayerTops(out);
    return { out, sized };
  }

  function drawNodeShape(g, n, w, h) {
    if (n.kind === "decision") {
      const i = DECISION_INSET;
      svgEl("path", { d: `M${i},0.5 H${w - i} L${w - 0.5},${h / 2} L${w - i},${h - 0.5} H${i} L0.5,${h / 2} Z`, class: "mv-node-box", "stroke-linejoin": "round" }, g);
    } else {
      const r = n.kind === "terminal" ? Math.min(h / 2, 16) : 8;
      svgEl("rect", { width: w, height: h, rx: r, class: "mv-node-box" }, g);
    }
  }

  function drawGraph(container, spec, best, scale) {
    const { out, sized } = best;
    const W = out.width, H = out.height;
    const flow = spec.variant === "flow";
    const svg = svgEl("svg", {
      viewBox: `0 0 ${W} ${H}`, width: Math.round(W * scale), height: Math.round(H * scale),
      role: "group", "aria-label": spec.title || "Diagram",
    });
    const edgeLayer = svgEl("g", { class: "mv-edges" }, svg);
    const nodeLayer = svgEl("g", { class: "mv-nodes" }, svg);
    const labelLayer = svgEl("g", { class: "mv-edge-labels" }, svg);
    const edgeEls = [];
    const nodeEls = new Map();

    out.edges.forEach((e, i) => {
      const src = spec.edges[i];
      const kind = src.kind || "default";
      const g = svgEl("g", { class: `mv-edge mv-edge--${kind}` }, edgeLayer);
      for (const s of e.sections || []) {
        const pts = [s.startPoint, ...(s.bendPoints || []), s.endPoint];
        svgEl("path", { d: roundedPath(pts, 6), class: "mv-edge-path" }, g);
        if (src.arrow !== false) {
          const a = pts[pts.length - 2], b = pts[pts.length - 1];
          const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
          const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len, L = 6.5, Wd = 3.5;
          const bx = b.x - ux * L, by = b.y - uy * L;
          svgEl("path", {
            class: "mv-arrow",
            d: `M${b.x},${b.y} L${bx - uy * Wd},${by + ux * Wd} L${bx + uy * Wd},${by - ux * Wd} Z`,
          }, g);
        }
      }
      const entry = { els: [g], s: src.source, t: src.target };
      for (const l of e.labels || []) {
        const lg = svgEl("g", { class: `mv-edge mv-edge--${kind}` }, labelLayer);
        svgEl("rect", { x: l.x, y: l.y, width: l.width, height: l.height, rx: 4, class: "mv-edge-label-bg" }, lg);
        const t = svgEl("text", { x: l.x + l.width / 2, y: l.y + l.height / 2 + 3.5, "text-anchor": "middle", class: "mv-edge-label" }, lg);
        t.textContent = l.text;
        entry.els.push(lg);
      }
      edgeEls.push(entry);
    });

    out.children.forEach((c) => {
      const n = spec.nodes.find((x) => x.id === c.id);
      const s = sized.get(c.id);
      const g = svgEl("g", { class: `mv-node mv-node--${n.kind || "default"}`, transform: `translate(${c.x},${c.y})`, "data-id": n.id }, nodeLayer);
      const name = [n.eyebrow, n.label, n.sublabel].filter(Boolean).join(", ");
      if (n.cite) setCite(g, n.cite, n.id, name);
      else { g.setAttribute("tabindex", "0"); g.setAttribute("aria-label", name); }
      drawNodeShape(g, n, c.width, c.height);
      const centred = flow || n.kind === "decision" || n.kind === "terminal";
      const x = centred ? c.width / 2 : PAD_X;
      const anchor = centred ? "middle" : "start";
      let y = 9;
      if (s.eyebrow) {
        const t = svgEl("text", { x, y: y + 9, "text-anchor": anchor, class: "mv-node-eyebrow" }, g);
        t.textContent = s.eyebrow;
        y += 13;
      }
      s.label.forEach((line) => {
        const t = svgEl("text", { x, y: y + 12.5, "text-anchor": anchor, class: "mv-node-label" }, g);
        t.textContent = line;
        y += 17;
      });
      if (s.sub.length) y += 1;
      s.sub.forEach((line) => {
        const t = svgEl("text", { x, y: y + 10.5, "text-anchor": anchor, class: "mv-node-sub" }, g);
        t.textContent = line;
        y += 14;
      });
      nodeEls.set(n.id, g);
    });

    const lite = (id) => {
      svg.classList.add("is-tracing");
      nodeEls.get(id).classList.add("is-lit");
      edgeEls.forEach((x) => {
        if (x.s !== id && x.t !== id) return;
        x.els.forEach((n) => n.classList.add("is-lit"));
        nodeEls.get(x.s).classList.add("is-lit");
        nodeEls.get(x.t).classList.add("is-lit");
      });
    };
    const unlite = () => {
      svg.classList.remove("is-tracing");
      svg.querySelectorAll(".is-lit").forEach((n) => n.classList.remove("is-lit"));
    };
    svg.addEventListener("mouseover", (ev) => { const n = ev.target.closest(".mv-node"); if (n) { unlite(); lite(n.dataset.id); } });
    svg.addEventListener("mouseleave", unlite);
    svg.addEventListener("focusin", (ev) => { const n = ev.target.closest(".mv-node"); if (n) { unlite(); lite(n.dataset.id); } });
    svg.addEventListener("focusout", unlite);
    container.replaceChildren(svg);
  }

  // Nesting starts from the accent node(s), else nodes with no incoming edge.
  // Relationships not used for nesting are written into the target's row.
  function drawOutline(container, spec) {
    const byId = new Map(spec.nodes.map((n) => [n.id, n]));
    const outgoing = new Map(spec.nodes.map((n) => [n.id, []]));
    spec.edges.forEach((e) => outgoing.get(e.source) && outgoing.get(e.source).push(e));
    let roots = spec.nodes.filter((n) => n.kind === "accent").map((n) => n.id);
    if (!roots.length) roots = spec.nodes.filter((n) => !spec.edges.some((e) => e.target === n.id)).map((n) => n.id);
    const treeEdge = new Map();
    const children = new Map(spec.nodes.map((n) => [n.id, []]));
    const placed = new Set(roots);
    const queue = roots.slice();
    while (queue.length) {
      const id = queue.shift();
      for (const e of outgoing.get(id)) {
        if (placed.has(e.target)) continue;
        placed.add(e.target);
        treeEdge.set(e.target, e);
        children.get(id).push(e.target);
        queue.push(e.target);
      }
    }
    const notes = new Map(spec.nodes.map((n) => [n.id, []]));
    spec.edges.forEach((e) => { if (treeEdge.get(e.target) !== e && placed.has(e.target)) notes.get(e.target).push(e); });
    spec.nodes.forEach((n) => {
      if (placed.has(n.id)) return;
      if (spec.edges.some((e) => e.source === n.id && placed.has(e.target))) return;
      placed.add(n.id);
      roots.push(n.id);
    });

    const verb = spec.incoming || "←";
    const item = (id) => {
      const n = byId.get(id);
      const li = htmlEl("li", "mv-outline-item" + (n.kind ? " is-" + n.kind : ""));
      const row = htmlEl("div", "mv-outline-row", null, li);
      setCite(row, n.cite, n.id, [n.label, n.sublabel].filter(Boolean).join(", "));
      const main = htmlEl("div", null, null, row);
      if (n.eyebrow) htmlEl("span", "mv-eyebrow", n.eyebrow, main);
      htmlEl("span", "mv-outline-title", n.label, main);
      if (n.sublabel) htmlEl("span", "mv-outline-sub", n.sublabel, main);
      for (const e of notes.get(id)) {
        const src = byId.get(e.source);
        const note = htmlEl("span", "mv-outline-note", verb + " ", main);
        const b = htmlEl("b", null, src.label, note);
        if (src.cite) setCite(b, src.cite, src.id, src.label);
        if (e.label) note.appendChild(document.createTextNode(", " + e.label));
      }
      const te = treeEdge.get(id);
      if (te && te.label) htmlEl("span", "mv-outline-edge" + (te.kind ? " is-" + te.kind : ""), te.label, row);
      // In a flow, a single main-path child continues at the same level so the
      // steps read top to bottom; only branches are indented under the step.
      let kids = children.get(id);
      let next = null;
      if (spec.variant === "flow") {
        const main = kids.filter((c) => treeEdge.get(c).exit !== "side");
        if (main.length === 1) { next = main[0]; kids = kids.filter((c) => c !== next); }
      }
      if (kids.length) {
        const ul = htmlEl("ul", null, null, li);
        kids.forEach((c) => item(c).forEach((x) => ul.appendChild(x)));
      }
      return next ? [li, ...item(next)] : [li];
    };
    const ul = htmlEl("ul", "mv-outline");
    ul.setAttribute("aria-label", spec.title || "Diagram");
    roots.forEach((r) => item(r).forEach((x) => ul.appendChild(x)));
    container.replaceChildren(ul);
  }

  async function graph(container, spec) {
    if (typeof container === "string") container = document.querySelector(container);
    if (typeof ELK === "undefined") throw new Error("MikeVisual.graph needs elkjs loaded first");
    spec = Object.assign({ direction: "auto", narrow: "outline", minFit: 0.85 }, spec);
    container.classList.add("mv-graph");
    await fontsReady();

    const render = async () => {
      const avail = innerWidth(container);
      const compact = avail < 560;
      const dirs = spec.direction !== "auto" ? [spec.direction] : ["DOWN", "RIGHT"];
      let best = null;
      for (const d of dirs) {
        const r = await layoutOnce(spec, d, compact);
        const fit = Math.min(1, avail / r.out.width);
        if (!best || fit > best.fit + 0.05) best = Object.assign(r, { fit, dir: d });
      }
      if (best.fit < spec.minFit && spec.narrow === "outline") {
        drawOutline(container, spec);
        container.dataset.mode = "outline";
        return { mode: "outline" };
      }
      drawGraph(container, spec, best, best.fit);
      container.dataset.mode = "drawing";
      return { mode: "drawing", direction: best.dir, scale: best.fit };
    };
    const result = await render();
    onWidthChange(container, render, 16);
    return result;
  }
  function graphTracked(container, spec) {
    return track(graph(container, spec));
  }

  const DAY = 86400000;
  const toTime = (iso) => (iso instanceof Date ? iso.getTime() : Date.parse(iso + (String(iso).length <= 10 ? "T00:00:00Z" : "")));
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function formatDate(iso, opts) {
    const d = new Date(toTime(iso));
    return opts && opts.short ? `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}` : `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  }
  const today = (spec) => (spec.today ? toTime(spec.today) : Date.UTC(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()));

  function tracks(container, spec) {
    if (typeof container === "string") container = document.querySelector(container);
    const rows = spec.rows;
    const times = rows.flatMap((r) => [toTime(r.from), r.to ? toTime(r.to) : toTime(r.from)]);
    const now = spec.today ? toTime(spec.today) : null;
    if (now) times.push(now);
    const y0 = new Date(Math.min(...times)).getUTCFullYear();
    const y1 = new Date(Math.max(...times)).getUTCFullYear() + 1;
    const start = spec.start ? toTime(spec.start) : Date.UTC(y0, 0, 1);
    const end = spec.end ? toTime(spec.end) : Date.UTC(y1, 0, 1);
    const pct = (t) => ((Math.min(end, Math.max(start, t)) - start) / (end - start)) * 100;

    const root = htmlEl("div", "mv-tracks");
    root.setAttribute("role", "list");
    if (spec.title) root.setAttribute("aria-label", spec.title);
    const lanes = [];
    rows.forEach((r) => {
      const row = htmlEl("div", "mv-tracks-row", null, root);
      row.setAttribute("role", "listitem");
      setCite(row, r.cite, null, r.label);
      const label = htmlEl("div", "mv-tracks-label", r.label, row);
      if (r.sub) htmlEl("small", null, r.sub, label);
      const lane = htmlEl("div", "mv-tracks-lane", null, row);
      lanes.push(lane);
      const kind = r.kind || (now && (r.to ? toTime(r.to) : toTime(r.from)) < now ? "done" : "");
      const when = r.to ? `${formatDate(r.from)} to ${formatDate(r.to)}` : formatDate(r.from);
      const mark = htmlEl("span", (r.to ? "mv-tracks-bar" : "mv-tracks-point") + (kind ? " is-" + kind : ""), null, lane);
      mark.style.left = pct(toTime(r.from)) + "%";
      if (r.to) mark.style.width = pct(toTime(r.to)) - pct(toTime(r.from)) + "%";
      mark.title = `${r.label}: ${when}`;
      htmlEl("span", "mv-sr", when, label);
    });
    const axisRow = htmlEl("div", "mv-tracks-row", null, root);
    axisRow.setAttribute("aria-hidden", "true");
    htmlEl("div", null, null, axisRow);
    const axis = htmlEl("div", "mv-tracks-axis", null, axisRow);
    container.replaceChildren(root);

    const draw = () => {
      root.querySelectorAll(".mv-tracks-overlay").forEach((n) => n.remove());
      axis.replaceChildren();
      const laneW = lanes[0].clientWidth || 200;
      const years = [];
      for (let y = new Date(start).getUTCFullYear(); Date.UTC(y, 0, 1) <= end; y++) if (Date.UTC(y, 0, 1) >= start) years.push(y);
      const every = Math.max(1, Math.ceil(years.length / Math.max(1, Math.floor(laneW / 44))));
      const overlay = htmlEl("div", "mv-tracks-overlay", null, root);
      overlay.style.cssText = `position:absolute;top:0;bottom:0;left:${lanes[0].offsetLeft}px;width:${laneW}px;pointer-events:none`;
      years.forEach((y, i) => {
        const p = pct(Date.UTC(y, 0, 1));
        htmlEl("i", "mv-tracks-grid", null, overlay).style.left = p + "%";
        if (i % every === 0 && p < 97) {
          const t = htmlEl("span", "mv-tracks-tick", laneW < 260 ? "’" + String(y).slice(2) : String(y), axis);
          t.style.left = p + "%";
        }
      });
      if (now) {
        const line = htmlEl("i", "mv-tracks-today", null, overlay);
        line.style.left = pct(now) + "%";
        line.style.bottom = "0";
        htmlEl("span", null, "Today", line).style.bottom = "-2px";
        axis.querySelectorAll(".mv-tracks-tick").forEach((t) => {
          if (Math.abs(parseFloat(t.style.left) - pct(now)) * laneW / 100 < 30) t.style.visibility = "hidden";
        });
      }
    };
    draw();
    onWidthChange(root, draw);
  }

  function timeline(container, spec) {
    if (typeof container === "string") container = document.querySelector(container);
    const now = today(spec);
    const ol = htmlEl("ol", "mv-timeline");
    // Markers continue the page's own cite numbering so no number is reused.
    let cited = Math.max(0, ...Array.from(document.querySelectorAll(".mv-cite"), (b) => +b.textContent || 0));
    spec.items.slice().sort((a, b) => toTime(a.date) - toTime(b.date)).forEach((it) => {
      const t = toTime(it.date);
      const done = it.done != null ? it.done : t < now;
      const li = htmlEl("li", "mv-tl-item" + (it.kind === "key" ? " is-key" : done ? " is-done" : ""), null, ol);
      const date = htmlEl("div", "mv-tl-date", formatDate(it.date), li);
      if (it.kicker) htmlEl("span", "mv-eyebrow", it.kicker, date);
      const body = htmlEl("div", "mv-tl-body", null, li);
      const title = htmlEl("div", "mv-tl-title", it.title, body);
      if (it.cite) {
        const button = htmlEl("button", "mv-cite", String(++cited), title);
        button.type = "button";
        setCite(button, it.cite, null, "Open source for " + it.title);
      }
      if (it.html) { const p = htmlEl("p", "mv-tl-text", null, body); p.innerHTML = it.html; }
      let status = it.status;
      if (it.period) {
        const a = toTime(it.period.from), b = toTime(it.period.to);
        const share = Math.round(Math.max(0, Math.min(1, (now - a) / (b - a))) * 100);
        const span = htmlEl("div", "mv-tl-span", null, body);
        span.setAttribute("role", "img");
        span.setAttribute("aria-label", `${it.period.label || "Period"} ${share}% elapsed`);
        htmlEl("i", null, null, span).style.width = share + "%";
        if (!status) status = `${it.period.label || "Period"} ${share}% elapsed`;
      }
      if (!done && it.kind === "key") {
        const days = Math.round((t - now) / DAY);
        const due = days === 0 ? "Due today" : days === 1 ? "Due tomorrow" : `Due in ${days} days`;
        status = (status ? status + ". " : "") + due;
      }
      if (status) htmlEl("p", "mv-tl-status" + (it.risk ? " is-risk" : ""), status, body);
    });
    glueCites(ol);
    container.replaceChildren(ol);
  }

  const blank = (v) => v == null || v === "";
  function cellText(value, col) {
    if (col.format === "date") return blank(value) ? "" : formatDate(value);
    if (col.format) return window.MikeVisual.chartFormat(col).full(value);
    return blank(value) ? "" : String(value);
  }
  function compareCells(a, b, col) {
    if (col.format === "date") return toTime(a) - toTime(b);
    if (typeof a === "number" && typeof b === "number") return a - b;
    return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
  }
  function citeButton(cite) {
    const button = htmlEl("button", "mv-table-cite", cite.label || "Open");
    button.type = "button";
    for (const k in cite) if (k !== "label") button.setAttribute("data-" + k.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase()), cite[k]);
    return button;
  }
  // Rows from a data block as a table: sortable headers, a search box and
  // more rows on request. Export draws every row and no controls.
  function table(container, spec) {
    if (typeof container === "string") container = document.querySelector(container);
    const columns = spec.columns.map((c) => Object.assign({ numeric: c.align === "right" || (c.format && c.format !== "date") }, c));
    const rows = spec.data.map((row) => {
      const cells = columns.map((c) => cellText(row[c.key], c));
      return { row, cells, text: cells.join(" ").toLowerCase() };
    });
    const cites = !EXPORT && rows.some((r) => r.row.cite);
    const pageSize = EXPORT ? Infinity : spec.pageSize || 50;
    const name = spec.caption || "Table";
    let sortKey = spec.sort ? spec.sort.replace(/^-/, "") : null;
    let sortDir = spec.sort && spec.sort[0] === "-" ? -1 : 1;
    let shown = pageSize;
    let query = "";

    const tableEl = htmlEl("table", "mv-table");
    if (spec.caption) htmlEl("caption", "mv-table-caption", spec.caption, tableEl);
    else tableEl.setAttribute("aria-label", name);
    const headRow = htmlEl("tr", null, null, htmlEl("thead", null, null, tableEl));
    const heads = columns.map((c) => {
      const th = htmlEl("th", c.numeric ? "mv-cell-num" : null, EXPORT ? c.label : null, headRow);
      th.setAttribute("scope", "col");
      if (!EXPORT) {
        const button = htmlEl("button", "mv-table-sort", c.label, th);
        button.type = "button";
        button.addEventListener("click", () => {
          sortDir = sortKey === c.key ? -sortDir : 1;
          sortKey = c.key;
          draw();
        });
      }
      return th;
    });
    if (cites) htmlEl("th", null, "Source", headRow).setAttribute("scope", "col");
    const tbody = htmlEl("tbody", null, null, tableEl);
    const wrap = htmlEl("div", "mv-table-wrap");
    wrap.appendChild(tableEl);
    const parts = [wrap];

    let foot, status, more, all;
    if (!EXPORT) {
      if (spec.search) {
        const tools = htmlEl("div", "mv-table-tools");
        const search = htmlEl("input", "mv-table-search", null, tools);
        search.type = "search";
        search.placeholder = "Search";
        search.setAttribute("aria-label", "Search " + name);
        search.addEventListener("input", () => {
          query = search.value.trim().toLowerCase();
          shown = pageSize;
          draw();
        });
        parts.unshift(tools);
      }
      foot = htmlEl("div", "mv-table-foot");
      status = htmlEl("span", null, null, foot);
      status.setAttribute("aria-live", "polite");
      more = htmlEl("button", "mv-table-more", null, foot);
      more.type = "button";
      more.addEventListener("click", () => { shown += pageSize; draw(); });
      all = htmlEl("button", "mv-table-more", "Show all", foot);
      all.type = "button";
      all.addEventListener("click", () => { shown = Infinity; draw(); });
      parts.push(foot);
    }

    const n = (v) => v.toLocaleString("en-GB");
    const draw = () => {
      const visible = query ? rows.filter((r) => r.text.includes(query)) : rows.slice();
      const col = columns.find((c) => c.key === sortKey);
      if (col) {
        visible.sort((x, y) => {
          const a = x.row[col.key], b = y.row[col.key];
          return blank(a) || blank(b) ? blank(a) - blank(b) : sortDir * compareCells(a, b, col);
        });
      }
      heads.forEach((th, i) => {
        if (columns[i] === col) th.setAttribute("aria-sort", sortDir > 0 ? "ascending" : "descending");
        else th.removeAttribute("aria-sort");
      });
      const page = visible.slice(0, shown);
      tbody.replaceChildren();
      page.forEach((r) => {
        const tr = htmlEl("tr", null, null, tbody);
        r.cells.forEach((text, i) => {
          const cls = columns[i].numeric ? "mv-cell-num" : columns[i].format || !i ? "mv-nowrap" : null;
          htmlEl("td", cls, text, tr);
        });
        if (cites) {
          const td = htmlEl("td", null, null, tr);
          if (r.row.cite) td.appendChild(citeButton(r.row.cite));
        }
      });
      if (!page.length) {
        const td = htmlEl("td", null, "No rows match", htmlEl("tr", "mv-table-empty", null, tbody));
        td.colSpan = heads.length + (cites ? 1 : 0);
      }
      if (!status) return;
      const rest = visible.length - page.length;
      const unit = query ? "matching rows" : "rows";
      status.textContent = rest ? `Showing ${n(page.length)} of ${n(visible.length)} ${unit}` : query ? `${n(visible.length)} of ${n(rows.length)} rows match` : "";
      more.textContent = `Show ${n(Math.min(pageSize, rest))} more`;
      more.hidden = all.hidden = !rest;
      foot.hidden = !status.textContent;
    };
    draw();
    container.classList.add("mv-table-fig");
    container.replaceChildren(...parts);
  }

  window.MikeVisual = { graph: graphTracked, tracks, timeline, tabs, table, formatDate, theme, onThemeChange, ready, data, track, postCite };
})();
