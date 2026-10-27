(function () {
  "use strict";

  var MV = (window.MikeVisual = window.MikeVisual || {});

  // Chart colours live in mike-visual.css as --mv-chart-* tokens; these are
  // the light values, used only when a token cannot be read.
  var LIGHT = {
    "--mv-chart-1": "#0088ff", "--mv-chart-2": "#cc7722", "--mv-chart-3": "#1f9e89", "--mv-chart-4": "#c4543f",
    "--mv-chart-5": "#7b68c8", "--mv-chart-6": "#7d9a2d", "--mv-chart-7": "#d4618c", "--mv-chart-8": "#a8871f",
  };

  function ec() {
    if (!window.echarts) throw new Error("MikeVisual charts need ECharts loaded before mike-charts.js");
    return window.echarts;
  }

  var reducedMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)");
  var EXPORT = document.documentElement.hasAttribute("data-mv-export");

  function prop(cs, name, fallback) {
    var v = cs.getPropertyValue(name).trim();
    return v || fallback;
  }

  function list(v) {
    return v.split(",").map(function (s) { return s.trim(); }).filter(Boolean);
  }

  function readTokens() {
    var cs = getComputedStyle(document.documentElement);
    var dark = MV.theme() === "dark";
    var t = {
      dark: dark,
      font: prop(cs, "--mv-font-sans", "Inter, ui-sans-serif, system-ui, sans-serif"),
      inkStrong: prop(cs, "--mv-ink-strong", dark ? "#f3f4f6" : "#111827"),
      ink: prop(cs, "--mv-ink", dark ? "#e5e7eb" : "#1f2937"),
      inkBody: prop(cs, "--mv-ink-body", dark ? "#d1d5db" : "#374151"),
      muted: prop(cs, "--mv-ink-muted", dark ? "#9ca3af" : "#6b7280"),
      faint: prop(cs, "--mv-ink-faint", dark ? "#7f8a99" : "#6b7280"),
      line: prop(cs, "--mv-line", dark ? "#2b3645" : "#e5e7eb"),
      lineSoft: prop(cs, "--mv-line-soft", dark ? "#202936" : "#f3f4f6"),
      lineStrong: prop(cs, "--mv-line-strong", dark ? "#3a4657" : "#d1d5db"),
      canvas: prop(cs, "--mv-canvas", dark ? "#0b0f14" : "#f9fafb"),
      surface: prop(cs, "--mv-surface", dark ? "#131922" : "#fdfdfe"),
      warning: prop(cs, "--mv-warning", dark ? "#fcd34d" : "#b45309"),
      danger: prop(cs, "--mv-danger", dark ? "#fca5a5" : "#b91c1c"),
      other: prop(cs, "--mv-chart-other", "#9ca3af"),
      neutral: prop(cs, "--mv-chart-neutral", "#d1d5db"),
      up: prop(cs, "--mv-chart-up", "#0088ff"),
      down: prop(cs, "--mv-chart-down", "#c4543f"),
      total: prop(cs, "--mv-chart-total", "#9ca3af"),
      track: prop(cs, "--mv-chart-track", "#e6f1fc"),
      seq: list(prop(cs, "--mv-chart-seq", "#eef6ff, #0088ff, #003f78")),
      ord: list(prop(cs, "--mv-chart-ord", "#003f78, #0056a3, #006ed0, #0088ff, #4da6ff")),
      palette: [],
    };
    for (var i = 1; i <= 8; i++) t.palette.push(prop(cs, "--mv-chart-" + i, LIGHT["--mv-chart-" + i]));
    t.bg = t.canvas;
    return t;
  }

  function parseColor(c) {
    c = String(c || "").trim();
    var m;
    if ((m = c.match(/^#([0-9a-f]{3})$/i))) {
      return [0, 1, 2].map(function (i) { return parseInt(m[1][i] + m[1][i], 16); }).concat(1);
    }
    if ((m = c.match(/^#([0-9a-f]{6})$/i))) {
      return [0, 2, 4].map(function (i) { return parseInt(m[1].slice(i, i + 2), 16); }).concat(1);
    }
    if ((m = c.match(/^rgba?\(([^)]+)\)$/i))) {
      var p = m[1].split(/[\s,/]+/).filter(Boolean).map(parseFloat);
      return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
    }
    return null;
  }

  function toHex(rgb) {
    return "#" + rgb.slice(0, 3).map(function (v) {
      return Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0");
    }).join("");
  }

  function luminance(c) {
    var rgb = parseColor(c);
    if (!rgb) return 0.5;
    var l = rgb.slice(0, 3).map(function (v) {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * l[0] + 0.7152 * l[1] + 0.0722 * l[2];
  }

  function contrast(a, b) {
    var x = luminance(a), y = luminance(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  }

  function inkOn(fill, t) {
    var dark = t.dark ? t.canvas : t.inkStrong;
    var light = "#ffffff";
    return contrast(fill, dark) >= contrast(fill, light) ? dark : light;
  }

  function mix(a, b, f) {
    var x = parseColor(a), y = parseColor(b);
    if (!x || !y) return a;
    return toHex([0, 1, 2].map(function (i) { return x[i] + (y[i] - x[i]) * f; }));
  }

  function rampAt(stops, f) {
    f = Math.max(0, Math.min(1, f));
    var seg = (stops.length - 1) * f;
    var i = Math.min(stops.length - 2, Math.floor(seg));
    return mix(stops[i], stops[i + 1], seg - i);
  }

  function surfaceOf(el, t) {
    for (var n = el; n && n.nodeType === 1; n = n.parentElement) {
      var c = parseColor(getComputedStyle(n).backgroundColor);
      if (c && c[3] >= 0.5) return toHex(c);
    }
    return t.canvas;
  }

  var symbols = {};
  function currencySymbol(code) {
    if (!symbols[code]) {
      try {
        var parts = new Intl.NumberFormat("en-GB", { style: "currency", currency: code }).formatToParts(1);
        symbols[code] = (parts.find(function (p) { return p.type === "currency"; }) || {}).value || code + " ";
      } catch (e) {
        symbols[code] = code + " ";
      }
    }
    return symbols[code];
  }

  function grouped(n, dp) {
    return n.toLocaleString("en-GB", { minimumFractionDigits: 0, maximumFractionDigits: dp });
  }

  function formatter(o) {
    o = o || {};
    var kind = o.format || "number";
    var sym = kind === "currency" ? currencySymbol(o.currency || "GBP") : "";
    var unit = o.unit ? " " + o.unit : "";
    var pct = kind === "percent" ? "%" : "";
    var minus = "−";

    function compactBody(a) {
      var steps = [[1e9, "bn"], [1e6, "m"], [1e3, "k"]];
      for (var i = 0; i < steps.length; i++) {
        if (a >= steps[i][0]) {
          var n = a / steps[i][0];
          return grouped(n, n < 10 ? (i < 2 ? 2 : 1) : 0) + steps[i][1];
        }
      }
      return grouped(a, a < 10 && a % 1 ? 1 : 0);
    }

    function full(v) {
      if (v == null || v === "" || isNaN(v)) return "–";
      var a = Math.abs(v);
      var dp = kind === "currency" ? (a < 100 && a % 1 ? 2 : 0) : kind === "percent" ? 1 : 2;
      return (v < 0 ? minus : "") + sym + grouped(a, dp) + pct + unit;
    }

    function compact(v) {
      if (v == null || v === "" || isNaN(v)) return "–";
      var a = Math.abs(v);
      var body = kind === "percent" ? grouped(a, a < 10 && a % 1 ? 1 : 0) : compactBody(a);
      return (v < 0 ? minus : "") + sym + body + pct + unit;
    }

    function signed(v) {
      return (v > 0 ? "+" : "") + compact(v);
    }

    function axis(v) {
      if (v === 0) return "0";
      var a = Math.abs(v);
      var body = kind === "percent" ? grouped(a, a < 10 && a % 1 ? 1 : 0) : compactBody(a);
      return (v < 0 ? minus : "") + sym + body + pct;
    }

    return { full: full, compact: compact, signed: signed, axis: axis };
  }

  function chartTheme(el) {
    var t = readTokens();
    var bg = el ? surfaceOf(el, t) : t.canvas;
    var motion = !EXPORT && !(reducedMotion && reducedMotion.matches);
    function axis(isCategory) {
      return {
        axisLine: { show: isCategory, lineStyle: { color: t.lineStrong, width: 1 } },
        axisTick: { show: false },
        axisLabel: { color: t.muted, fontSize: 11, fontFamily: t.font, hideOverlap: true, margin: 8 },
        splitLine: { show: !isCategory, lineStyle: { color: t.line, width: 1, type: "solid" } },
        splitArea: { show: false },
        nameTextStyle: { color: t.muted, fontSize: 11, fontFamily: t.font },
      };
    }
    return {
      color: t.palette.slice(),
      backgroundColor: "transparent",
      animation: motion,
      animationDuration: motion ? 450 : 0,
      animationDurationUpdate: motion ? 300 : 0,
      animationEasing: "cubicOut",
      textStyle: { fontFamily: t.font, color: t.inkBody, fontSize: 12 },
      title: {
        left: 0, top: 0,
        textStyle: { color: t.inkStrong, fontSize: 14, fontWeight: 500, fontFamily: t.font },
        subtextStyle: { color: t.muted, fontSize: 12, fontFamily: t.font },
      },
      legend: {
        icon: "roundRect", itemWidth: 10, itemHeight: 10, itemGap: 14,
        textStyle: { color: t.muted, fontSize: 12, fontFamily: t.font },
        inactiveColor: t.lineStrong,
        pageIconColor: t.muted, pageTextStyle: { color: t.muted },
      },
      tooltip: {
        backgroundColor: t.surface, borderColor: t.line, borderWidth: 1, padding: [6, 8],
        textStyle: { color: t.ink, fontSize: 12, fontFamily: t.font },
        extraCssText: "box-shadow:0 1px 3px rgba(0,0,0,.08);border-radius:8px;",
        axisPointer: {
          lineStyle: { color: t.lineStrong, width: 1, type: "solid" },
          crossStyle: { color: t.lineStrong, width: 1, type: "solid" },
          shadowStyle: { color: t.dark ? "rgba(255,255,255,0.04)" : "rgba(17,24,39,0.04)" },
        },
      },
      grid: { left: 4, right: 8, top: 12, bottom: 4, containLabel: true },
      categoryAxis: axis(true),
      valueAxis: axis(false),
      logAxis: axis(false),
      timeAxis: Object.assign(axis(true), { splitLine: { show: false } }),
      line: {
        symbol: "circle", symbolSize: 8, smooth: false,
        lineStyle: { width: 2 },
        itemStyle: { borderColor: bg, borderWidth: 2 },
      },
      bar: { barMaxWidth: 24, itemStyle: { borderRadius: [4, 4, 0, 0] } },
      pie: {
        itemStyle: { borderColor: bg, borderWidth: 2 },
        label: { color: t.inkBody, fontSize: 11 },
        labelLine: { lineStyle: { color: t.lineStrong } },
      },
      scatter: { itemStyle: { borderColor: bg, borderWidth: 1.5, opacity: 0.85 } },
      radar: {
        symbol: "circle", symbolSize: 6,
        lineStyle: { width: 2 },
        areaStyle: { opacity: 0.1 },
        axisName: { color: t.muted, fontSize: 11 },
        splitLine: { lineStyle: { color: t.line } },
        splitArea: { show: false },
        axisLine: { lineStyle: { color: t.line } },
      },
      sankey: {
        nodeWidth: 10, nodeGap: 12, draggable: false,
        lineStyle: { color: "source", opacity: 0.28, curveness: 0.5 },
        itemStyle: { borderWidth: 0 },
        label: { color: t.inkBody, fontSize: 11 },
        emphasis: { focus: "adjacency" },
      },
      funnel: { itemStyle: { borderWidth: 0 }, label: { color: t.inkBody, fontSize: 11 } },
      gauge: {
        axisLine: { lineStyle: { color: [[1, t.track]] } },
        axisTick: { show: false }, splitLine: { show: false }, axisLabel: { show: false },
        pointer: { show: false }, anchor: { show: false },
        detail: { color: t.inkStrong, fontWeight: 500 },
        title: { color: t.muted },
      },
      treemap: {
        breadcrumb: { show: false }, roam: false, nodeClick: false,
        itemStyle: { borderColor: bg, borderWidth: 2, gapWidth: 2, borderRadius: 3 },
      },
      heatmap: { itemStyle: { borderColor: bg, borderWidth: 2, borderRadius: 3 } },
    };
  }

  var themeCache = {};
  function themeName(el) {
    var theme = chartTheme(el);
    var key = JSON.stringify(theme);
    if (!themeCache[key]) {
      themeCache[key] = "mike-" + Object.keys(themeCache).length;
      ec().registerTheme(themeCache[key], theme);
    }
    return themeCache[key];
  }

  function humanize(f) {
    return String(f).replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, function (c) { return c.toUpperCase(); });
  }

  var measureCtx = null;
  function textW(s, size) {
    if (!measureCtx) {
      measureCtx = document.createElement("canvas").getContext("2d");
    }
    if (!measureCtx) return String(s).length * (size || 11) * 0.56;
    measureCtx.font = (size || 11) + "px " + readTokens().font;
    return measureCtx.measureText(String(s)).width;
  }

  function bucketOf(w) {
    return w < 400 ? "narrow" : w < 640 ? "medium" : "wide";
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  function tipRow(color, name, value) {
    return '<div class="mvt-r">' + (color ? '<i style="background:' + color + '"></i>' : "") +
      "<span>" + esc(name) + "</span><b>" + esc(value) + "</b></div>";
  }

  function tipHead(s) {
    return '<div class="mvt-h">' + esc(s) + "</div>";
  }

  function citeNote(d) {
    return d && d.cite ? '<div class="mvt-c">Click to open source</div>' : "";
  }

  function colorAt(t, i) {
    return i < t.palette.length ? t.palette[i] : t.other;
  }

  function seriesDefs(spec, t) {
    var raw = spec.series || (Array.isArray(spec.y) ? spec.y : [spec.y || "value"]);
    return raw.map(function (s, i) {
      if (typeof s === "string") s = { field: s };
      return Object.assign({}, s, {
        name: s.name || humanize(s.field),
        color: s.color || colorAt(t, s.colorIndex != null ? s.colorIndex : i),
      });
    });
  }

  function hasCite(rows) {
    return (rows || []).some(function (r) { return r && r.cite; });
  }

  function niceCeil(v) {
    if (!(v > 0)) return v;
    var mag = Math.pow(10, Math.floor(Math.log10(v)));
    var steps = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
    for (var i = 0; i < steps.length; i++) if (steps[i] * mag >= v) return steps[i] * mag;
    return 10 * mag;
  }

  // A limit, target or threshold drawn across the value axis. A horizontal
  // line carries its label in the plot, at whichever end is further from the
  // drawn data; the vertical line of a horizontal bar chart is named in the
  // legend instead, because ECharts would rotate the label along it.
  function referenceLines(spec, ctx, F, horizontal, rowTops) {
    var t = ctx.t;
    var refs = (spec.reference == null ? [] : [].concat(spec.reference))
      .map(function (r) { return typeof r === "number" ? { value: r } : r; })
      .filter(function (r) { return r && r.value != null; });
    if (!refs.length) return null;
    var label = function (r) { return r.label || F.compact(r.value); };
    var side = function (v) {
      var first = rowTops[0], last = rowTops[rowTops.length - 1];
      return rowTops.length > 1 && Math.abs(first - v) > Math.abs(last - v) ? "insideStartTop" : "insideEndTop";
    };
    return {
      mark: {
        silent: true, symbol: "none", animation: false, label: { show: false },
        lineStyle: { color: t.inkStrong, width: 1.25, type: [4, 3] },
        data: refs.map(function (r) {
          var d = {};
          d[horizontal ? "xAxis" : "yAxis"] = r.value;
          if (!horizontal) {
            d.label = { show: true, position: side(+r.value), formatter: label(r), color: t.inkStrong, fontSize: 11, backgroundColor: ctx.bg, padding: [1, 3] };
          }
          return d;
        }),
      },
      legend: horizontal ? refs.map(function (r) { return { name: label(r), color: t.inkStrong, shape: "line", dashed: true }; }) : [],
      top: Math.max.apply(null, refs.map(function (r) { return +r.value; })),
    };
  }

  function categoryLabelFit(labels, band, narrow, ordered) {
    if (labels.length > 12 && band < 40) return { interval: "auto" };
    var longest = Math.max.apply(null, labels.map(function (l) { return textW(l); }));
    if (longest <= band - 6) return { interval: 0 };
    if (ordered && longest <= band * 3 - 8) return { interval: "auto" };
    var words = [];
    labels.forEach(function (l) { words = words.concat(String(l).split(/\s+/)); });
    var longestWord = Math.max.apply(null, words.map(function (w) { return textW(w); }));
    if (longestWord <= band - 6 && longest <= (band - 6) * 3) {
      return { interval: 0, width: Math.max(24, band - 6), overflow: "break", lineHeight: 13 };
    }
    return { interval: 0, rotate: 40, width: narrow ? 84 : 120, overflow: "truncate" };
  }

  function labelsFor(rows, xf, narrow, band, horizontal) {
    var full = rows.map(function (r) { return String(r[xf]); });
    if (!rows.some(function (r) { return r.short; })) return full;
    var shorts = rows.map(function (r) { return String(r.short || r[xf]); });
    if (horizontal) return narrow ? shorts : full;
    return narrow || categoryLabelFit(full, band, narrow).rotate ? shorts : full;
  }

  function buildCartesian(spec, ctx) {
    var t = ctx.t, narrow = ctx.bucket === "narrow", width = ctx.width;
    var type = spec.type;
    var horizontal = !!(spec.horizontal || spec.orientation === "horizontal");
    var rows = spec.data || [];
    var xf = spec.x || "label";
    var n = rows.length;
    var labels = labelsFor(rows, xf, narrow, (width - 44) / Math.max(1, n), horizontal);
    var defs = seriesDefs(spec, t);
    var F = formatter(spec);
    var single = defs.length === 1;
    var stacked = spec.stacked != null ? !!spec.stacked : type === "area" && defs.length > 1;
    var cite = hasCite(rows);

    var kinds = defs.map(function (d, i) {
      if (d.type) return d.type;
      if (type === "combo") return i === 0 ? "bar" : "line";
      return type === "area" ? "line" : type;
    });
    var barIdx = kinds.map(function (k, i) { return k === "bar" ? i : -1; }).filter(function (i) { return i >= 0; });
    var lastBar = barIdx[barIdx.length - 1];
    var anyBar = barIdx.length > 0;

    var totals = rows.map(function (r) {
      return defs.reduce(function (s, d, i) { return kinds[i] === "bar" ? s + (+r[d.field] || 0) : s; }, 0);
    });

    var valueLabels = anyBar && n <= 12 && (horizontal || !narrow || n <= 6) && (single || stacked);
    var hideValueAxis = horizontal && valueLabels && spec.axis !== true;

    var series = defs.map(function (d, i) {
      var kind = kinds[i];
      var isBar = kind === "bar";
      var data = rows.map(function (r, ri) {
        var item = { value: r[d.field] };
        if (r.cite) item.cite = r.cite;
        if (isBar && single && spec.highlight != null) {
          var hit = Array.isArray(spec.highlight)
            ? spec.highlight.indexOf(r[xf]) >= 0
            : spec.highlight === r[xf] || spec.highlight === ri;
          item.itemStyle = { color: hit ? d.color : t.neutral };
        }
        return item;
      });
      var s = { name: d.name, type: kind, data: data, cursor: cite ? "pointer" : "default", emphasis: { disabled: true } };
      if (isBar) {
        var r = !stacked || i === lastBar ? 4 : 0;
        s.barMaxWidth = 24;
        s.itemStyle = { color: d.color, borderRadius: horizontal ? [0, r, r, 0] : [r, r, 0, 0] };
        if (stacked) {
          s.stack = "total";
          s.itemStyle.borderColor = ctx.bg;
          s.itemStyle.borderWidth = 1.5;
        } else if (!single) {
          s.barGap = "15%";
        }
        if (valueLabels && (!stacked || i === lastBar)) {
          s.label = {
            show: true, position: horizontal ? "right" : "top", distance: 4,
            color: t.inkBody, fontSize: 11,
            formatter: function (p) { return F.compact(stacked ? totals[p.dataIndex] : p.value); },
          };
        }
      } else {
        var area = type === "area" || d.area;
        s.lineStyle = { width: 2, color: d.color };
        s.itemStyle = { color: d.color, borderColor: ctx.bg, borderWidth: 2 };
        s.showSymbol = n <= 12;
        s.symbolSize = 8;
        if (area) {
          s.areaStyle = { color: d.color, opacity: stacked ? 0.14 : single ? 0.1 : 0.06 };
          if (stacked) s.stack = "area";
        }
        if (single && !narrow && n > 1) {
          s.endLabel = { show: true, color: t.inkBody, fontSize: 11, distance: 6, formatter: function (p) { return F.compact(p.value); } };
        }
      }
      return s;
    });

    var plotW = width - (hideValueAxis ? 0 : 44);
    var catAxis = { type: "category", data: labels, boundaryGap: anyBar || n < 2 };
    var valAxis = { type: "value", splitNumber: narrow ? 3 : 4, axisLabel: { formatter: function (v) { return F.axis(v); } } };
    if (spec.min != null) valAxis.min = spec.min;
    if (spec.max != null) valAxis.max = spec.max;
    var rowTops = rows.map(function (r) {
      var sums = {}, top = 0;
      defs.forEach(function (d, i) {
        var v = +r[d.field] || 0, stack = series[i].stack;
        top = Math.max(top, stack ? (sums[stack] = (sums[stack] || 0) + v) : v);
      });
      return top;
    });
    var ref = referenceLines(spec, ctx, F, horizontal, rowTops);
    if (ref && series.length) {
      // Its own empty series, so hiding a data series from the legend keeps the line.
      series.push({ name: "__ref", type: "line", data: [], silent: true, tooltip: { show: false }, markLine: ref.mark });
      var dataMax = Math.max.apply(null, [0].concat(rowTops));
      if (spec.max == null && ref.top >= dataMax) valAxis.max = niceCeil(ref.top * 1.12);
    }

    var height, grid = { left: 4, right: 8, top: 12, bottom: 4, containLabel: true };
    if (!catAxis.boundaryGap && !horizontal) grid.right = Math.max(grid.right, Math.ceil(textW(labels[n - 1]) / 2) + 2);
    if (horizontal) {
      var capW = narrow ? Math.round(width * 0.36) : Math.min(220, Math.round(width * 0.3));
      var lines = Math.max.apply(null, labels.map(function (l) { return Math.ceil(textW(l) / capW); }));
      var rowH = Math.max(single || stacked ? 30 : defs.length * 13 + 14, Math.min(lines, 3) * 14 + 10);
      catAxis.inverse = true;
      catAxis.axisLabel = { width: capW, overflow: "break", lineHeight: 14, interval: 0 };
      if (hideValueAxis) {
        // containLabel reserves room for the labels even of a hidden axis.
        valAxis.show = false;
        valAxis.axisLabel = { show: false };
        valAxis.splitLine = { show: false };
        var widest = Math.max.apply(null, totals.map(function (v) { return textW(F.compact(v)); }));
        grid.right = Math.ceil(widest) + 10;
      } else {
        var top = Math.max.apply(null, rows.map(function (r) { return Math.max.apply(null, defs.map(function (d) { return +r[d.field] || 0; })); }));
        grid.right = Math.max(grid.right, Math.ceil(textW(F.axis(top)) / 2) + 4);
      }
      height = n * rowH + (hideValueAxis ? 8 : 30);
      grid.top = 4;
    } else {
      var band = plotW / Math.max(1, n);
      var ordered = !anyBar || labels.every(function (l) { return /^(\d|Q\d|(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec))/.test(l); });
      catAxis.axisLabel = categoryLabelFit(labels, band, narrow, ordered);
      if (valueLabels) grid.top = 22;
      var hasEndLabel = series.some(function (s) { return s.endLabel; });
      if (hasEndLabel) {
        var lastVals = series.map(function (s) { return textW(F.compact(s.data[n - 1] && s.data[n - 1].value)); });
        grid.right = Math.ceil(Math.max.apply(null, lastVals)) + 14;
      }
      height = narrow ? 220 : ctx.bucket === "medium" ? 240 : 280;
      if (catAxis.axisLabel.rotate) height += 30;
    }

    var option = {
      grid: grid,
      legend: { show: false, data: defs.map(function (d) { return d.name; }) },
      xAxis: horizontal ? valAxis : catAxis,
      yAxis: horizontal ? catAxis : valAxis,
      series: series,
      tooltip: {
        trigger: "axis", confine: true,
        axisPointer: { type: anyBar ? "shadow" : "line" },
        formatter: function (ps) {
          if (!ps.length) return "";
          var row = rows[ps[0].dataIndex] || {};
          var out = tipHead(row[xf]);
          ps.forEach(function (p) { out += tipRow(p.color, p.seriesName, F.full(p.value)); });
          if (stacked && defs.length > 1 && anyBar) out += tipRow(null, "Total", F.full(totals[ps[0].dataIndex]));
          return out + citeNote(row);
        },
      },
    };

    var legend = single ? [] : defs.map(function (d, i) {
      return { name: d.name, color: d.color, shape: kinds[i] === "line" && !(type === "area" || d.area) ? "line" : "box", toggle: true };
    });
    if (ref) legend = legend.concat(ref.legend);

    return { option: option, height: spec.height || height, legend: legend.length ? legend : null };
  }

  function buildWaterfall(spec, ctx) {
    var t = ctx.t, narrow = ctx.bucket === "narrow", width = ctx.width;
    var rows = spec.data || [];
    var xf = spec.x || "label", vf = spec.y || "value";
    var F = formatter(spec);
    var upColor = spec.increase === "bad" ? t.down : t.up;
    var downColor = spec.increase === "bad" ? t.up : t.down;
    var run = 0, low = 0, high = 0, base = [], bars = [];
    rows.forEach(function (r) {
      var v = +r[vf] || 0;
      if (r.total) {
        var tot = r[vf] != null ? v : run;
        base.push(0);
        bars.push({ value: tot, kind: "total", delta: tot, cite: r.cite, itemStyle: { color: t.total, borderRadius: [4, 4, 0, 0] } });
        run = tot;
      } else {
        base.push(v >= 0 ? run : run + v);
        bars.push({ value: Math.abs(v), kind: v >= 0 ? "up" : "down", delta: v, cite: r.cite, itemStyle: { color: v >= 0 ? upColor : downColor, borderRadius: 2 } });
        run += v;
      }
      low = Math.min(low, run, base[base.length - 1]);
      high = Math.max(high, Math.abs(run));
    });
    var band = (width - 44) / Math.max(1, rows.length);
    var labels = labelsFor(rows, xf, narrow, band, false);
    var showLabels = band >= 30;
    // Rounding noise in the running total must not push the axis below zero.
    var min = spec.min != null ? spec.min : low >= -1e-9 * high ? 0 : undefined;
    var option = {
      grid: { left: 4, right: 8, top: showLabels ? 22 : 12, bottom: 4, containLabel: true },
      xAxis: { type: "category", data: labels, axisLabel: categoryLabelFit(labels, band, narrow) },
      yAxis: { type: "value", min: min, splitNumber: narrow ? 3 : 4, axisLabel: { formatter: function (v) { return F.axis(v); } } },
      series: [
        { name: "__base", type: "bar", stack: "w", data: base, itemStyle: { color: "transparent" }, emphasis: { disabled: true }, tooltip: { show: false }, silent: true, barMaxWidth: 28 },
        {
          name: spec.name || "Change", type: "bar", stack: "w", data: bars, barMaxWidth: 28, barMinHeight: 3, emphasis: { disabled: true },
          cursor: hasCite(rows) ? "pointer" : "default",
          label: {
            show: showLabels, position: "top", distance: 4, color: t.inkBody, fontSize: narrow ? 10 : 11,
            formatter: function (p) { return p.data.kind === "total" ? F.compact(p.data.delta) : F.signed(p.data.delta); },
          },
        },
      ],
      tooltip: {
        trigger: "item", confine: true,
        formatter: function (p) {
          var d = p.data, r = rows[p.dataIndex] || {};
          return tipHead(r[xf]) + tipRow(p.color, d.kind === "total" ? "Total" : d.kind === "up" ? "Increase" : "Decrease",
            d.kind === "total" ? F.full(d.delta) : (d.delta > 0 ? "+" : "") + F.full(d.delta)) + citeNote(r);
        },
      },
    };
    var height = (narrow ? 220 : ctx.bucket === "medium" ? 240 : 280) + (option.xAxis.axisLabel.rotate ? 30 : 0);
    var legend = [
      { kind: "up", name: spec.increaseLabel || "Increase", color: upColor, shape: "box" },
      { kind: "down", name: spec.decreaseLabel || "Decrease", color: downColor, shape: "box" },
      { kind: "total", name: spec.totalLabel || "Total", color: t.total, shape: "box" },
    ].filter(function (it) { return bars.some(function (b) { return b.kind === it.kind; }); });
    return { option: option, height: spec.height || height, legend: legend };
  }

  function buildPie(spec, ctx) {
    var t = ctx.t, narrow = ctx.bucket === "narrow";
    var nf = spec.x || "name", vf = spec.y || "value";
    var F = formatter(spec);
    var rows = (spec.data || []).slice();
    if (rows.length > 7) {
      var rest = rows.slice(6).reduce(function (s, r) { return s + (+r[vf] || 0); }, 0);
      rows = rows.slice(0, 6);
      var other = {};
      other[nf] = "Other";
      other[vf] = rest;
      rows.push(other);
    }
    var total = rows.reduce(function (s, r) { return s + (+r[vf] || 0); }, 0);
    var doughnut = spec.type === "doughnut";
    var h = spec.height || (narrow ? 200 : 260);
    var outerR = Math.min(ctx.width, h) / 2 * 0.68;
    var side = ctx.width / 2 - outerR - 22;
    var longestName = Math.max.apply(null, rows.map(function (r) { return textW(String(r[nf])); }));
    var labelsOutside = !narrow && spec.labels !== false && longestName <= side;
    var items = rows.map(function (r, i) {
      var c = r[nf] === "Other" && i === rows.length - 1 && (spec.data || []).length > 7 ? t.other : colorAt(t, i);
      return { name: String(r[nf]), value: r[vf], cite: r.cite, itemStyle: { color: c } };
    });
    var pct = function (v) { return total ? Math.round((v / total) * 100) + "%" : ""; };
    var series = {
      type: "pie",
      radius: doughnut ? (labelsOutside ? ["46%", "68%"] : ["58%", "84%"]) : ["0%", labelsOutside ? "68%" : "84%"],
      center: ["50%", "50%"],
      startAngle: 90,
      data: items,
      cursor: hasCite(rows) ? "pointer" : "default",
      itemStyle: { borderColor: ctx.bg, borderWidth: 2, borderRadius: doughnut ? 3 : 0 },
      emphasis: { scale: false },
      avoidLabelOverlap: true,
      label: labelsOutside
        ? {
            show: true, color: t.muted, fontSize: 11, lineHeight: 15,
            formatter: function (p) { return "{n|" + p.name + "}\n{v|" + pct(p.value) + "}"; },
            rich: { n: { color: t.muted, fontSize: 11 }, v: { color: t.inkStrong, fontSize: 12, fontWeight: 500 } },
          }
        : { show: false },
      labelLine: { show: labelsOutside, length: 8, length2: 8, lineStyle: { color: t.lineStrong } },
    };
    var option = {
      legend: { show: false },
      series: [series],
      tooltip: {
        trigger: "item", confine: true,
        formatter: function (p) {
          return tipRow(p.color, p.name, F.full(p.value)) + tipRow(null, "Share", pct(p.value)) + citeNote(p.data);
        },
      },
    };
    if (doughnut && spec.center !== false) {
      option.graphic = [{
        type: "text", left: "center", top: "middle", silent: true,
        style: {
          text: "{v|" + F.compact(total) + "}\n{l|" + (spec.centerLabel || "Total") + "}",
          align: "center", verticalAlign: "middle",
          rich: {
            v: { fontSize: narrow ? 18 : 20, fontWeight: 500, fill: t.inkStrong, fontFamily: t.font, lineHeight: 24, align: "center" },
            l: { fontSize: 11, fill: t.muted, fontFamily: t.font, lineHeight: 15, align: "center" },
          },
        },
      }];
    }
    var legend = labelsOutside ? null : items.map(function (it) {
      return { name: it.name, color: it.itemStyle.color, shape: "box", value: F.compact(it.value) + ", " + pct(it.value), toggle: true };
    });
    return { option: option, height: h, legend: legend };
  }

  function buildGauge(spec, ctx) {
    var t = ctx.t, narrow = ctx.bucket === "narrow";
    var F = formatter(spec);
    var min = spec.min || 0, max = spec.max != null ? spec.max : 100;
    var value = spec.value != null ? spec.value : (spec.data && spec.data[0] && spec.data[0].value) || 0;
    var color = t.palette[0];
    if (spec.warnAt != null && value >= spec.warnAt) color = t.warning;
    if (spec.dangerAt != null && value >= spec.dangerAt) color = t.danger;
    var gh = spec.height || (ctx.bucket === "wide" ? 200 : 170);
    var gaugeR = Math.min((gh - 12) / 1.5, ctx.width / 2 - 8);
    var ofText = [spec.label, spec.of === false ? "" : "of " + F.compact(max)].filter(Boolean).join(" ");
    var option = {
      series: [{
        type: "gauge", min: min, max: max, startAngle: 210, endAngle: -30,
        radius: gaugeR, center: ["50%", gaugeR + 6],
        progress: { show: true, width: narrow ? 10 : 12, itemStyle: { color: color } },
        axisLine: { lineStyle: { width: narrow ? 10 : 12, color: [[1, t.track]] } },
        axisTick: { show: false }, splitLine: { show: false }, axisLabel: { show: false },
        pointer: { show: false }, anchor: { show: false },
        title: { show: false },
        detail: {
          valueAnimation: false, offsetCenter: [0, "4%"], fontFamily: t.font,
          formatter: function (v) { return "{v|" + F.compact(v) + "}" + (ofText ? "\n{o|" + ofText + "}" : ""); },
          rich: {
            v: { fontSize: narrow ? 24 : 28, fontWeight: 500, color: t.inkStrong, lineHeight: 32 },
            o: { fontSize: 12, color: t.muted, lineHeight: 16 },
          },
        },
        data: [{ value: value, name: spec.label || "" }],
      }],
      tooltip: { show: false },
    };
    return { option: option, height: gh, legend: null };
  }

  function buildScatter(spec, ctx) {
    var t = ctx.t, narrow = ctx.bucket === "narrow";
    var rows = spec.data || [];
    var xf = spec.x || "x", yf = spec.y || "y", sf = spec.size, gf = spec.group, lf = spec.label;
    var F = formatter(spec);
    var FX = formatter(spec.xFormat || {});
    var bubble = spec.type === "bubble" && sf;
    var groups = [];
    if (gf) rows.forEach(function (r) { if (groups.indexOf(r[gf]) < 0) groups.push(r[gf]); });
    else groups = [spec.name || "Series"];
    var sizes = bubble ? rows.map(function (r) { return +r[sf] || 0; }) : [];
    var smax = bubble ? Math.max.apply(null, sizes) : 1;
    var maxR = narrow ? 30 : 42;
    var labelAll = lf && rows.length <= (narrow ? 6 : 10);
    var series = groups.map(function (g, gi) {
      var color = colorAt(t, gi);
      var data = rows.filter(function (r) { return !gf || r[gf] === g; }).map(function (r) {
        var item = { value: [r[xf], r[yf], bubble ? r[sf] : null], name: lf ? r[lf] : "", cite: r.cite };
        if (lf && (labelAll || r.labelled)) item.label = { show: true };
        return item;
      });
      return {
        type: "scatter", name: String(g), data: data,
        cursor: hasCite(rows) ? "pointer" : "default",
        symbolSize: bubble ? function (v) { return Math.max(8, Math.sqrt(Math.max(0, v[2]) / smax) * maxR); } : 9,
        itemStyle: { color: color, opacity: bubble ? 0.72 : 0.9, borderColor: ctx.bg, borderWidth: 1.5 },
        emphasis: { scale: 1.1, itemStyle: { opacity: 1 } },
        label: { show: false, position: "right", distance: 4, color: t.inkBody, fontSize: 11, formatter: function (p) { return p.name; } },
        labelLayout: { hideOverlap: true },
      };
    });
    var option = {
      grid: { left: 4, right: 24, top: spec.yName ? 26 : 12, bottom: spec.xName ? 24 : 4, containLabel: true },
      legend: { show: false, data: groups.map(String) },
      xAxis: {
        type: "value", scale: spec.zero === false, splitNumber: narrow ? 3 : 5,
        boundaryGap: lf ? [0, "12%"] : [0, 0],
        axisLine: { show: true }, splitLine: { show: false },
        name: spec.xName || "", nameLocation: "middle", nameGap: 26,
        axisLabel: { formatter: function (v) { return FX.axis(v); } },
      },
      yAxis: {
        type: "value", scale: spec.zero === false, splitNumber: narrow ? 3 : 4,
        name: spec.yName || "", nameLocation: "end", nameGap: 10,
        nameTextStyle: { align: "left", padding: [0, 0, 0, 0] },
        axisLabel: { formatter: function (v) { return F.axis(v); } },
      },
      series: series,
      tooltip: {
        trigger: "item", confine: true,
        formatter: function (p) {
          var v = p.value;
          var out = p.name ? tipHead(p.name) : "";
          if (gf) out += tipRow(p.color, humanize(gf), p.seriesName);
          out += tipRow(gf ? null : p.color, spec.xName || humanize(xf), FX.full(v[0]));
          out += tipRow(null, spec.yName || humanize(yf), F.full(v[1]));
          if (bubble) out += tipRow(null, spec.sizeName || humanize(sf), formatter(spec.sizeFormat || {}).full(v[2]));
          return out + citeNote(p.data);
        },
      },
    };
    var legend = gf ? groups.map(function (g, gi) { return { name: String(g), color: colorAt(t, gi), shape: "dot", toggle: true }; }) : null;
    return { option: option, height: spec.height || (narrow ? 260 : 300), legend: legend };
  }

  function buildHeatmap(spec, ctx) {
    var t = ctx.t, narrow = ctx.bucket === "narrow", width = ctx.width;
    var rows = spec.data || [];
    var xf = spec.x || "x", yf = spec.y || "y", vf = spec.value || "value";
    var F = formatter(spec);
    function uniq(f) {
      var out = [];
      rows.forEach(function (r) { if (out.indexOf(r[f]) < 0) out.push(r[f]); });
      return out;
    }
    var xDefs = spec.xCategories || uniq(xf);
    var xs = xDefs.map(function (c) { return c && typeof c === "object" ? c.name : c; });
    var ys = spec.yCategories || uniq(yf);
    var vals = rows.map(function (r) { return +r[vf]; });
    var min = spec.min != null ? spec.min : Math.min.apply(null, vals);
    var max = spec.max != null ? spec.max : Math.max.apply(null, vals);
    var capW = narrow ? Math.round(width * 0.3) : Math.min(180, Math.round(width * 0.24));
    var cellW = Math.min(160, (width - capW - 8) / Math.max(1, xs.length));
    var showLabels = spec.labels !== false && cellW >= 26;
    var filled = {};
    var data = rows.map(function (r) {
      var f = max > min ? (+r[vf] - min) / (max - min) : 0.5;
      var c = rampAt(t.seq, f);
      var xi = xs.indexOf(r[xf]), yi = ys.indexOf(r[yf]);
      filled[xi + "," + yi] = true;
      return { value: [xi, yi, r[vf]], cite: r.cite, itemStyle: { color: c }, label: { color: inkOn(c, t) } };
    });
    xs.forEach(function (x, xi) {
      ys.forEach(function (y, yi) {
        if (filled[xi + "," + yi]) return;
        data.push({ value: [xi, yi, null], itemStyle: { color: "transparent", borderColor: t.line, borderType: "dashed", borderWidth: 1 }, label: { show: false } });
      });
    });
    var xLabels = xs.map(String);
    var xShort = xDefs.map(function (c) { return String(c && typeof c === "object" && c.short ? c.short : c && c.name || c); });
    if (narrow || categoryLabelFit(xLabels, cellW, narrow).rotate) xLabels = xShort;
    var lines = Math.max.apply(null, ys.map(function (y) { return Math.ceil(textW(y) / capW); }));
    var cellH = Math.max(narrow ? 30 : 32, Math.min(lines, 3) * 14 + 8);
    var fit = categoryLabelFit(xLabels, cellW, narrow);
    var option = {
      grid: { left: 4, right: Math.max(0, Math.floor(width - capW - 8 - cellW * xs.length)), top: 4, bottom: 4, containLabel: true },
      xAxis: { type: "category", data: xLabels, position: "bottom", axisLine: { show: false }, splitArea: { show: false }, axisLabel: fit },
      yAxis: { type: "category", data: ys.map(String), inverse: true, axisLine: { show: false }, axisLabel: { width: capW, overflow: "break", lineHeight: 14, interval: 0 } },
      series: [{
        type: "heatmap", data: data,
        cursor: hasCite(rows) ? "pointer" : "default",
        itemStyle: { borderColor: ctx.bg, borderWidth: 2, borderRadius: 3 },
        label: { show: showLabels, fontSize: 11, formatter: function (p) { return F.compact(p.value[2]); } },
        emphasis: { itemStyle: { borderColor: t.inkStrong, borderWidth: 1 } },
      }],
      tooltip: {
        trigger: "item", confine: true,
        formatter: function (p) {
          var v = p.value[2];
          return tipHead(ys[p.value[1]]) + tipRow(v == null ? null : p.color, String(xs[p.value[0]]), v == null ? "Not stated" : F.full(v)) + citeNote(p.data);
        },
      },
    };
    var height = ys.length * cellH + (fit.rotate ? 74 : fit.overflow ? 46 : 34);
    var scale = { scale: [0, 0.25, 0.5, 0.75, 1].map(function (f) { return rampAt(t.seq, f); }), low: (spec.scaleLabels || [])[0] || F.compact(min), high: (spec.scaleLabels || [])[1] || F.compact(max) };
    return { option: option, height: spec.height || height, legend: scale };
  }

  function buildTreemap(spec, ctx) {
    var t = ctx.t, narrow = ctx.bucket === "narrow";
    var F = formatter(spec);
    var nf = spec.x || "name", vf = spec.y || "value";
    function sum(r) {
      return r.children ? r.children.reduce(function (s, c) { return s + sum(c); }, 0) : +r[vf] || 0;
    }
    var rows = spec.data || [];
    var total = rows.reduce(function (s, r) { return s + sum(r); }, 0);
    var minShare = narrow ? 0.06 : 0.035;
    function node(r, color) {
      var v = sum(r);
      var n = { name: String(r[nf]), value: v, cite: r.cite, itemStyle: { color: color }, label: { show: v / total >= minShare, color: inkOn(color, t) } };
      if (r.children) n.children = r.children.map(function (c) { return node(c, color); });
      return n;
    }
    var data = rows.map(function (r, i) { return node(r, colorAt(t, i)); });
    var option = {
      series: [{
        type: "treemap", data: data, left: 0, right: 0, top: 0, bottom: 0, width: "100%", height: "100%",
        roam: false, nodeClick: false, breadcrumb: { show: false }, squareRatio: 0.9,
        cursor: hasCite(rows) ? "pointer" : "default",
        itemStyle: { borderColor: ctx.bg, borderWidth: 0, gapWidth: 2, borderRadius: 3 },
        levels: [{ itemStyle: { gapWidth: 2, borderWidth: 0 } }, { itemStyle: { gapWidth: 1, borderWidth: 0 }, colorSaturation: [0.55, 0.85] }],
        label: {
          position: "insideTopLeft", padding: [6, 8], fontSize: 11, lineHeight: 15, overflow: "truncate",
          formatter: function (p) { return "{n|" + p.name + "}\n{v|" + F.compact(p.value) + "}"; },
          rich: { n: { fontSize: 11, fontWeight: 500 }, v: { fontSize: 11 } },
        },
        upperLabel: { show: false },
      }],
      tooltip: {
        trigger: "item", confine: true,
        formatter: function (p) {
          return tipRow(p.color, p.name, F.full(p.value)) + tipRow(null, "Share", Math.round((p.value / total) * 100) + "%") + citeNote(p.data);
        },
      },
    };
    var legend = data.map(function (d) { return { name: d.name, color: d.itemStyle.color, shape: "box" }; });
    return { option: option, height: spec.height || (narrow ? 240 : 280), legend: data.length > 1 ? legend : null };
  }

  function buildSankey(spec, ctx) {
    var t = ctx.t, narrow = ctx.bucket === "narrow";
    var F = formatter(spec);
    var links = spec.links || spec.data || [];
    var names = [];
    (spec.nodes || []).forEach(function (n) { names.push(typeof n === "string" ? n : n.name); });
    links.forEach(function (l) {
      if (names.indexOf(l.source) < 0) names.push(l.source);
      if (names.indexOf(l.target) < 0) names.push(l.target);
    });
    var depth = {};
    var incoming = {};
    links.forEach(function (l) { incoming[l.target] = true; });
    names.forEach(function (n) { if (!incoming[n]) depth[n] = 0; });
    for (var pass = 0; pass < names.length; pass++) {
      links.forEach(function (l) {
        if (depth[l.source] != null) depth[l.target] = Math.max(depth[l.target] || 0, depth[l.source] + 1);
      });
    }
    var maxDepth = Math.max.apply(null, names.map(function (n) { return depth[n] || 0; }));
    var srcIdx = 0;
    var nodes = names.map(function (n) {
      var d = depth[n] || 0;
      var color = d === 0 ? colorAt(t, srcIdx++) : t.other;
      var label = d === maxDepth ? { position: "left" } : { position: "right" };
      return { name: n, depth: d, itemStyle: { color: color }, label: label };
    });
    var option = {
      series: [{
        type: "sankey", left: 0, right: 0, top: 4, bottom: 4,
        nodeWidth: 10, nodeGap: narrow ? 12 : 18, nodeAlign: "justify", layoutIterations: 64, draggable: false,
        data: nodes,
        links: links.map(function (l) { return { source: l.source, target: l.target, value: l.value, cite: l.cite }; }),
        cursor: hasCite(links) ? "pointer" : "default",
        lineStyle: { color: "source", opacity: 0.2, curveness: 0.5 },
        emphasis: { focus: "adjacency", lineStyle: { opacity: 0.5 } },
        label: {
          color: t.inkBody, fontSize: 11, distance: 6, textBorderColor: ctx.bg, textBorderWidth: 3,
          formatter: function (p) { return narrow ? p.name : p.name + "  {v|" + F.compact(p.value) + "}"; },
          rich: { v: { color: t.muted, fontSize: 11, textBorderColor: ctx.bg, textBorderWidth: 3 } },
        },
      }],
      tooltip: {
        trigger: "item", confine: true,
        formatter: function (p) {
          if (p.dataType === "edge") return tipRow(null, p.data.source + " → " + p.data.target, F.full(p.data.value)) + citeNote(p.data);
          return tipRow(p.color, p.name, F.full(p.value));
        },
      },
    };
    var perCol = {};
    names.forEach(function (n) { perCol[depth[n] || 0] = (perCol[depth[n] || 0] || 0) + 1; });
    var tallest = Math.max.apply(null, Object.keys(perCol).map(function (k) { return perCol[k]; }));
    return { option: option, height: spec.height || Math.max(narrow ? 260 : 280, tallest * (narrow ? 44 : 48)), legend: null };
  }

  function buildFunnel(spec, ctx) {
    var t = ctx.t, narrow = ctx.bucket === "narrow";
    var F = formatter(spec);
    var nf = spec.x || "name", vf = spec.y || "value";
    var rows = spec.data || [];
    var first = +rows[0] && +rows[0][vf] || (rows[0] ? +rows[0][vf] : 1);
    var data = rows.map(function (r, i) {
      var c = rows.length <= t.ord.length ? t.ord[Math.round((i * (t.ord.length - 1)) / Math.max(1, rows.length - 1))] : rampAt(t.ord, i / (rows.length - 1));
      return { name: String(r[nf]), value: r[vf], cite: r.cite, itemStyle: { color: c } };
    });
    var option = {
      series: [{
        type: "funnel", sort: "none", gap: 2, left: 0, top: 4, bottom: 4, width: narrow ? "50%" : "56%",
        minSize: "16%", maxSize: "100%", funnelAlign: "center",
        data: data,
        cursor: hasCite(rows) ? "pointer" : "default",
        itemStyle: { borderWidth: 0 },
        emphasis: { disabled: true },
        label: {
          show: true, position: "right", color: t.inkBody, fontSize: 11, lineHeight: 15,
          formatter: function (p) {
            var share = first ? Math.round((p.value / first) * 100) : 0;
            return "{n|" + p.name + "}\n{v|" + F.compact(p.value) + "}" + (p.dataIndex ? "{m|  " + share + "%}" : "");
          },
          rich: { n: { color: t.inkBody, fontSize: 11 }, v: { color: t.inkStrong, fontSize: 12, fontWeight: 500 }, m: { color: t.muted, fontSize: 11 } },
        },
        labelLine: { show: true, length: 10, lineStyle: { color: t.lineStrong, width: 1 } },
      }],
      tooltip: {
        trigger: "item", confine: true,
        formatter: function (p) { return tipRow(p.color, p.name, F.full(p.value)) + citeNote(p.data); },
      },
    };
    return { option: option, height: spec.height || Math.max(180, rows.length * 44), legend: null };
  }

  function buildRadar(spec, ctx) {
    var t = ctx.t, narrow = ctx.bucket === "narrow";
    var F = formatter(spec);
    var rows = spec.data || [];
    var xf = spec.x || "label";
    var defs = seriesDefs(spec, t);
    var max = spec.max;
    if (max == null) {
      max = 0;
      rows.forEach(function (r) { defs.forEach(function (d) { max = Math.max(max, +r[d.field] || 0); }); });
    }
    var nameW = narrow ? 70 : 110;
    var widest = Math.max.apply(null, rows.map(function (r) { return Math.min(nameW, textW(String(narrow && r.short ? r.short : r[xf]))); }));
    var h = spec.height || (narrow ? 280 : 320);
    var radarRadius = Math.max(60, Math.min(h * 0.36, ctx.width / 2 - widest - 12));
    var option = {
      legend: { show: false, data: defs.map(function (d) { return d.name; }) },
      radar: {
        indicator: rows.map(function (r) { return { name: String(narrow && r.short ? r.short : r[xf]), max: max }; }),
        radius: radarRadius, center: ["50%", "52%"], splitNumber: 4, shape: "polygon",
        axisName: { color: t.muted, fontSize: 11, width: nameW, overflow: "break" },
        splitLine: { lineStyle: { color: t.line } }, splitArea: { show: false }, axisLine: { lineStyle: { color: t.line } },
      },
      series: [{
        type: "radar", emphasis: { disabled: true },
        data: defs.map(function (d) {
          return {
            name: d.name, value: rows.map(function (r) { return r[d.field]; }),
            itemStyle: { color: d.color, borderColor: ctx.bg, borderWidth: 1.5 },
            lineStyle: { color: d.color, width: 2 },
            areaStyle: { color: d.color, opacity: 0.1 },
            symbol: "circle", symbolSize: 6,
          };
        }),
      }],
      tooltip: {
        trigger: "item", confine: true,
        formatter: function (p) {
          var out = tipHead(p.name);
          rows.forEach(function (r, i) { out += tipRow(null, String(r[xf]), F.full(p.value[i])); });
          return out;
        },
      },
    };
    var legend = defs.length > 1 ? defs.map(function (d) { return { name: d.name, color: d.color, shape: "line", toggle: true }; }) : null;
    return { option: option, height: h, legend: legend };
  }

  var BUILDERS = {
    bar: buildCartesian, line: buildCartesian, area: buildCartesian, combo: buildCartesian,
    waterfall: buildWaterfall, budget: buildWaterfall,
    pie: buildPie, doughnut: buildPie, donut: buildPie,
    gauge: buildGauge,
    scatter: buildScatter, bubble: buildScatter,
    heatmap: buildHeatmap, treemap: buildTreemap, sankey: buildSankey, funnel: buildFunnel, radar: buildRadar,
  };

  function tableModel(spec) {
    var F = formatter(spec);
    var type = spec.type;
    var rows = spec.data || [];
    var head, body;
    if (type === "sankey") {
      head = ["From", "To", "Value"];
      body = (spec.links || rows).map(function (l) { return [l.source, l.target, F.full(l.value), l.cite]; });
    } else if (type === "gauge") {
      head = [spec.label || "Value", "Of"];
      body = [[F.full(spec.value), F.full(spec.max != null ? spec.max : 100)]];
    } else if (type === "heatmap") {
      var xf = spec.x || "x", yf = spec.y || "y", vf = spec.value || "value";
      head = [humanize(yf), humanize(xf), humanize(vf)];
      body = rows.map(function (r) { return [r[yf], r[xf], F.full(r[vf]), r.cite]; });
    } else if (type === "scatter" || type === "bubble") {
      var FX = formatter(spec.xFormat || {});
      head = [];
      if (spec.label) head.push(humanize(spec.label));
      if (spec.group) head.push(humanize(spec.group));
      head.push(spec.xName || humanize(spec.x || "x"), spec.yName || humanize(spec.y || "y"));
      if (spec.size) head.push(spec.sizeName || humanize(spec.size));
      body = rows.map(function (r) {
        var out = [];
        if (spec.label) out.push(r[spec.label]);
        if (spec.group) out.push(r[spec.group]);
        out.push(FX.full(r[spec.x || "x"]), F.full(r[spec.y || "y"]));
        if (spec.size) out.push(formatter(spec.sizeFormat || {}).full(r[spec.size]));
        out.push(r.cite);
        return out;
      });
    } else if (type === "treemap") {
      var nf = spec.x || "name", tv = spec.y || "value";
      head = ["Item", "Value"];
      body = [];
      (function walk(list, prefix) {
        list.forEach(function (r) {
          var label = prefix ? prefix + " / " + r[nf] : r[nf];
          if (r.children) walk(r.children, label);
          else body.push([label, F.full(r[tv]), r.cite]);
        });
      })(rows, "");
    } else if (BUILDERS[type] === buildPie || type === "funnel" || BUILDERS[type] === buildWaterfall) {
      var pn = spec.x || (BUILDERS[type] === buildWaterfall ? "label" : "name"), pv = spec.y || "value";
      head = [humanize(pn), humanize(pv)];
      body = rows.map(function (r) { return [r[pn], F.full(r[pv]), r.cite]; });
    } else {
      var defs = seriesDefs(spec, { palette: [], other: "" });
      var x = spec.x || "label";
      head = [humanize(x)].concat(defs.map(function (d) { return d.name; }));
      body = rows.map(function (r) {
        return [r[x]].concat(defs.map(function (d) { return F.full(r[d.field]); }), [r.cite]);
      });
    }
    return { head: head, body: body };
  }

  function renderTable(spec, mode) {
    var m = tableModel(spec);
    var anyCite = m.body.some(function (r) { return r[r.length - 1]; });
    var table = document.createElement("table");
    table.className = "mv-table";
    var html = "";
    if (spec.title) html += '<caption class="mv-sr-only">' + esc(spec.title) + "</caption>";
    html += "<thead><tr>" + m.head.map(function (h, i) {
      return '<th scope="col"' + (i ? ' class="mv-cell-num"' : "") + ">" + esc(h) + "</th>";
    }).join("") + (anyCite ? '<th scope="col">Source</th>' : "") + "</tr></thead><tbody>";
    m.body.forEach(function (r, ri) {
      var cite = r[r.length - 1];
      var cells = r.slice(0, m.head.length);
      html += "<tr>" + cells.map(function (c, i) {
        return i ? '<td class="mv-cell-num">' + esc(c) + "</td>" : '<th scope="row" style="font-weight:400;text-align:left">' + esc(c) + "</th>";
      }).join("");
      if (anyCite) html += "<td>" + (cite ? '<button type="button" data-chart-cite="' + ri + '">' + esc(cite.label || "Open") + "</button>" : "") + "</td>";
      html += "</tr>";
    });
    table.innerHTML = html + "</tbody>";
    table.addEventListener("click", function (e) {
      var b = e.target.closest && e.target.closest("[data-chart-cite]");
      if (b) postCite(m.body[+b.getAttribute("data-chart-cite")].slice(-1)[0]);
    });
    var wrap = document.createElement("div");
    wrap.className = "mv-table-wrap";
    wrap.appendChild(table);
    if (mode === "details") {
      var det = document.createElement("details");
      det.className = "mv-chart-data";
      det.innerHTML = "<summary>Show data</summary>";
      det.appendChild(wrap);
      return det;
    }
    var hidden = document.createElement("div");
    hidden.className = "mv-chart-data mv-sr-only";
    hidden.appendChild(wrap);
    return hidden;
  }

  function postCite(cite) {
    if (cite && MV.postCite) MV.postCite(cite);
  }

  function bindCite(chart) {
    chart.on("click", function (p) {
      if (p.data && p.data.cite) postCite(p.data.cite);
    });
  }

  function renderLegend(box, legend, inst) {
    box.innerHTML = "";
    if (!legend) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    if (legend.scale) {
      box.innerHTML = '<span class="mv-chart-scale">' + esc(legend.low) + "<span>" +
        legend.scale.map(function (c) { return '<i style="background:' + c + '"></i>'; }).join("") + "</span>" + esc(legend.high) + "</span>";
      return;
    }
    legend.forEach(function (it) {
      var el = document.createElement(it.toggle ? "button" : "span");
      el.className = "mv-legend-item";
      if (it.toggle) {
        el.type = "button";
        var on = !inst.hidden[it.name];
        el.setAttribute("aria-pressed", String(on));
        el.addEventListener("click", function () {
          inst.hidden[it.name] = !inst.hidden[it.name];
          el.setAttribute("aria-pressed", String(!inst.hidden[it.name]));
          inst.chart.dispatchAction({ type: "legendToggleSelect", name: it.name });
        });
      }
      var sw = document.createElement("span");
      sw.setAttribute("aria-hidden", "true");
      if (it.shape === "line") {
        sw.className = "mv-swatch mv-swatch--line" + (it.dashed ? "-dashed" : "");
        sw.style.borderTopColor = it.color;
        sw.style.borderTopWidth = it.dashed ? "1.5px" : "2px";
      } else {
        sw.className = "mv-swatch";
        sw.style.background = it.color;
        sw.style.borderColor = "transparent";
        if (it.shape === "dot") sw.style.borderRadius = "50%";
        sw.style.width = sw.style.height = "10px";
        sw.style.borderRadius = it.shape === "dot" ? "50%" : "3px";
      }
      el.appendChild(sw);
      var label = document.createElement("span");
      label.textContent = it.name;
      el.appendChild(label);
      if (it.value) {
        var v = document.createElement("span");
        v.className = "mv-chart-lv";
        v.textContent = it.value;
        el.appendChild(v);
      }
      box.appendChild(el);
    });
  }

  var instances = [];

  // zrender caches text widths per font, so anything measured before Inter
  // arrives keeps fallback-font widths and clips labels.
  var fontsReady = (function () {
    if (!document.fonts || !document.fonts.load) return Promise.resolve();
    var fam = readTokens().font;
    var loads = Promise.all(["400 11px ", "500 12px "].map(function (w) { return document.fonts.load(w + fam).catch(function () {}); }));
    return Promise.race([loads, new Promise(function (r) { setTimeout(r, 2500); })]);
  })();

  function start(inst) {
    instances.push(inst);
    var drawn = fontsReady.then(function () {
      draw(inst, true);
      observe(inst);
    });
    if (MV.track) MV.track(drawn);
  }

  function draw(inst, force) {
    var plot = inst.plot;
    var w = Math.round(plot.clientWidth || inst.root.clientWidth || 360);
    var bucket = bucketOf(w);
    var name = themeName(plot);
    var t = readTokens();
    var ctx = { t: t, width: w, bucket: bucket, bg: surfaceOf(plot, t), format: formatter };
    var res = inst.build(ctx);
    if (res.height) plot.style.height = res.height + "px";
    if (!inst.chart || inst.theme !== name) {
      if (inst.chart) inst.chart.dispose();
      inst.chart = ec().init(plot, name, { renderer: "svg" });
      inst.theme = name;
      bindCite(inst.chart);
      force = true;
    }
    if (force || inst.bucket !== bucket || inst.width !== w) {
      var opt = res.option;
      if (EXPORT) opt.tooltip = { show: false };
      if (opt.legend && Object.keys(inst.hidden).length) {
        opt.legend.selected = {};
        Object.keys(inst.hidden).forEach(function (k) { opt.legend.selected[k] = !inst.hidden[k]; });
      }
      inst.chart.setOption(opt, true);
      inst.chart.resize();
    }
    if (inst.legendBox) {
      renderLegend(inst.legendBox, res.legend, inst);
      inst.root.classList.toggle("is-narrow", bucket === "narrow");
    }
    inst.bucket = bucket;
    inst.width = w;
  }

  function observe(inst) {
    var pending = false;
    inst.ro = new ResizeObserver(function () {
      if (pending) return;
      pending = true;
      requestAnimationFrame(function () {
        pending = false;
        var w = Math.round(inst.plot.clientWidth);
        if (!w || w === inst.width) return;
        if (bucketOf(w) !== inst.bucket || inst.rebuildOnResize) draw(inst, true);
        else {
          inst.width = w;
          inst.chart.resize();
        }
      });
    });
    inst.ro.observe(inst.plot);
  }

  function handle(inst) {
    return {
      get instance() { return inst.chart; },
      update: function (next) {
        inst.update(next);
        draw(inst, true);
      },
      dispose: function () {
        inst.ro.disconnect();
        inst.chart.dispose();
        instances.splice(instances.indexOf(inst), 1);
      },
    };
  }

  function resolveEl(el) {
    var node = typeof el === "string" ? document.querySelector(el) : el;
    if (!node) throw new Error("MikeVisual: chart container not found");
    return node;
  }

  function chart(el, spec) {
    var root = resolveEl(el);
    var build = BUILDERS[spec.type];
    if (!build) throw new Error("MikeVisual.chart: unsupported type " + spec.type);
    root.innerHTML = "";
    root.classList.add("mv-chart-fig");
    if (spec.title || spec.subtitle) {
      var head = document.createElement("div");
      head.className = "mv-chart-head";
      if (spec.title) head.innerHTML = '<div class="mv-chart-title">' + esc(spec.title) + "</div>";
      if (spec.subtitle) head.innerHTML += '<div class="mv-chart-sub">' + esc(spec.subtitle) + "</div>";
      root.appendChild(head);
    }
    var legendBox = document.createElement("div");
    legendBox.className = "mv-legend mv-chart-legend";
    root.appendChild(legendBox);
    var plot = document.createElement("div");
    plot.className = "mv-chart-plot";
    plot.setAttribute("role", "img");
    plot.setAttribute("aria-label", [spec.title, spec.subtitle, spec.description].filter(Boolean).join(". ") || spec.label || humanize(spec.type) + " chart");
    root.appendChild(plot);
    if (spec.table !== false && spec.type !== "gauge" || spec.table) {
      root.appendChild(renderTable(spec, spec.table === "details" ? "details" : "hidden"));
    }
    var inst = {
      root: root, plot: plot, legendBox: legendBox, hidden: {}, spec: spec,
      rebuildOnResize: ["heatmap", "bar", "waterfall", "budget", "combo", "line", "area", "treemap"].indexOf(spec.type) >= 0,
      build: function (ctx) { return build(inst.spec, ctx); },
      update: function (next) { inst.spec = next; },
    };
    start(inst);
    return handle(inst);
  }

  function rawEcharts(el, option, opts) {
    opts = opts || {};
    var plot = resolveEl(el);
    if (!plot.clientHeight) plot.style.height = (opts.height || 300) + "px";
    plot.setAttribute("role", "img");
    var title = option && option.title && (Array.isArray(option.title) ? option.title[0] : option.title);
    plot.setAttribute("aria-label", opts.label || (title && title.text) || "Chart");
    var inst = {
      root: plot, plot: plot, legendBox: null, hidden: {}, option: option, rebuildOnResize: typeof option === "function",
      build: function (ctx) {
        var o = typeof inst.option === "function" ? inst.option(ctx) : inst.option;
        return { option: o, height: opts.height };
      },
      update: function (next) { inst.option = next; },
    };
    start(inst);
    return handle(inst);
  }

  var scheduled = false;
  function redrawAll() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(function () {
      scheduled = false;
      instances.forEach(function (inst) { draw(inst, true); });
    });
  }

  if (window.matchMedia) {
    var mq = window.matchMedia("(prefers-color-scheme: dark)");
    if (mq.addEventListener) mq.addEventListener("change", redrawAll);
    if (reducedMotion && reducedMotion.addEventListener) reducedMotion.addEventListener("change", redrawAll);
  }
  new MutationObserver(redrawAll).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class", "style"] });

  MV.chartTheme = chartTheme;
  MV.chart = chart;
  MV.echarts = rawEcharts;
  MV.chartFormat = formatter;
  MV.chartTokens = readTokens;
})();
