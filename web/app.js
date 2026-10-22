const state = {
  instances: [],
  topology: { links: [] },
  nodeLayout: {},
  topoErrors: {},
  foldersByInstance: {},
  instanceTransferStats: {},
  syncByInstanceId: {},
  /** @type {Record<string, string>} last syncStatus per instance (geen % — alleen echte statuswissels loggen) */
  syncStatusSnapshot: {},
  /** @type {Record<string, Array<{ at: string, fromLabel: string, toLabel: string, fromStatus: string, toStatus: string }>>} */
  syncStatusLog: {},
  selectedInstanceId: null,
  range: "24h",
  chartInstance: "",
  editingId: null,
  transferChart: null,
  speedChart: null,
  /** @type {Chart[]} */
  folderDiskCharts: [],
};

const TOPO_W = 1000;
const TOPO_H = 560;

async function pbRequest(path, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  const res = await fetch(path, { ...options, headers });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.message || res.statusText;
    throw new Error(`PocketBase ${res.status}: ${msg}`);
  }
  return data;
}

async function listAll(collection, params = {}) {
  const q = new URLSearchParams({ perPage: "200", ...params });
  let page = 1;
  const items = [];
  for (;;) {
    q.set("page", String(page));
    const res = await pbRequest(`/api/collections/${collection}/records?${q}`);
    items.push(...(res.items || []));
    if (page >= res.totalPages) break;
    page += 1;
  }
  return items;
}

function parsePbDate(s) {
  if (!s) return null;
  return new Date(String(s).replace(" ", "T"));
}

function toPbFilterDate(d) {
  return d.toISOString().replace("T", " ").replace("Z", "Z");
}

function formatBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let x = v / 1024;
  let i = 0;
  while (x >= 1024 && i < units.length - 1) {
    x /= 1024;
    i += 1;
  }
  return `${x.toFixed(x >= 100 ? 0 : 1)} ${units[i]}`;
}

function formatSpeed(bps) {
  const v = Number(bps) || 0;
  if (v < 1024) return `${v.toFixed(2)} B/s`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let x = v / 1024;
  let i = 0;
  while (x >= 1024 && i < units.length - 1) {
    x /= 1024;
    i += 1;
  }
  return `${x.toFixed(2)} ${units[i]}/s`;
}

const SPEED_HISTORY_MINUTES = 480;

function rangeStart(range) {
  const now = new Date();
  switch (range) {
    case "8h":
      return new Date(now.getTime() - 8 * 3600 * 1000);
    case "24h":
      return new Date(now.getTime() - 24 * 3600 * 1000);
    case "7d":
      return new Date(now.getTime() - 7 * 24 * 3600 * 1000);
    case "month":
      return new Date(now.getTime() - 30 * 24 * 3600 * 1000);
    case "31d":
      return new Date(now.getTime() - 31 * 24 * 3600 * 1000);
    default:
      return new Date(0);
  }
}

function sumTransferRows(rows) {
  let inBytes = 0;
  let outBytes = 0;
  for (const row of rows) {
    inBytes += Number(row.in_bytes_delta) || 0;
    outBytes += Number(row.out_bytes_delta) || 0;
  }
  return { inBytes, outBytes };
}

function instanceTransferFilter(instanceId, from, useHourly) {
  const timeField = useHourly ? "bucket_start" : "recorded_at";
  return `instance = "${instanceId}" && ${timeField} >= "${toPbFilterDate(from)}"`;
}

async function loadInstanceTransferStats(instanceId) {
  const inst = state.instances.find((i) => i.id === instanceId);
  const alltime = {
    inBytes: inst ? bytesAlltimeIn(inst) : 0,
    outBytes: inst ? bytesAlltimeOut(inst) : 0,
  };

  const from24 = rangeStart("24h");
  const from7 = rangeStart("7d");
  const from31 = rangeStart("31d");

  const [rows24, rows7, rows31] = await Promise.all([
    listAll("transfer_samples", {
      filter: instanceTransferFilter(instanceId, from24, false),
      sort: "recorded_at",
    }),
    listAll("transfer_samples", {
      filter: instanceTransferFilter(instanceId, from7, false),
      sort: "recorded_at",
    }),
    listAll("transfer_hourly", {
      filter: instanceTransferFilter(instanceId, from31, true),
      sort: "bucket_start",
    }),
  ]);

  return {
    h24: sumTransferRows(rows24),
    d7: sumTransferRows(rows7),
    d31: sumTransferRows(rows31),
    alltime,
  };
}

function renderInstanceStatsBody(stats) {
  const row = (label, totals) =>
    `<tr><th scope="row">${escapeHtml(label)}</th><td class="num">${formatBytes(totals.inBytes)}</td><td class="num">${formatBytes(totals.outBytes)}</td></tr>`;
  return `<table class="transfer-period-table">
    <thead><tr><th scope="col">Periode</th><th scope="col">Ontvangen</th><th scope="col">Verzonden</th></tr></thead>
    <tbody>
      ${row("24 uur", stats.h24)}
      ${row("7 dagen", stats.d7)}
      ${row("31 dagen", stats.d31)}
      ${row("All-time", stats.alltime)}
    </tbody>
  </table>
  <p class="hint tiny stats-footnote">24u/7d/31d = som deltas · All-time = collector totaal · 31d via uuraggregatie</p>`;
}

function buildSyncStatusLogHtml(instanceId) {
  const entries = state.syncStatusLog[instanceId] || [];
  if (!entries.length) {
    return `<p class="hint tiny sync-log-empty">Nog geen sync-statuswijzigingen gelogd (wijzigingen verschijnen na topology-refresh).</p>`;
  }
  return `<ul class="sync-log-list">${entries
    .map((e) => {
      const when = new Date(e.at);
      const timeStr = Number.isNaN(when.getTime()) ? e.at : when.toLocaleString();
      return `<li><time datetime="${escapeAttr(e.at)}">${escapeHtml(timeStr)}</time> <span class="sync-log-change">${escapeHtml(e.fromLabel)} → ${escapeHtml(e.toLabel)}</span></li>`;
    })
    .join("")}</ul>`;
}

function refreshSyncLogPanel(instanceId) {
  const body = document.getElementById("sync-status-log-body");
  if (!body || state.selectedInstanceId !== instanceId) return;
  body.innerHTML = buildSyncStatusLogHtml(instanceId);
}

function syncStatusLogLabel(syncStatus, progressPercent) {
  switch (syncStatus) {
    case "syncing":
      if (progressPercent != null && !Number.isNaN(Number(progressPercent))) {
        return `Syncen (${Number(progressPercent)}%)`;
      }
      return "Syncen";
    case "scanning":
      return "Scannen";
    case "uptodate":
      return "Bijgewerkt";
    case "standby":
      return "Standby";
    default:
      return "—";
  }
}

function recordSyncStatusChanges(topologyInstances) {
  for (const ti of topologyInstances || []) {
    const id = ti.instanceId;
    if (!id) continue;
    const nextStatus = ti.syncStatus || "unknown";
    const prevStatus = state.syncStatusSnapshot[id];
    if (prevStatus === undefined) {
      state.syncStatusSnapshot[id] = nextStatus;
      continue;
    }
    if (prevStatus !== nextStatus) {
      if (!state.syncStatusLog[id]) state.syncStatusLog[id] = [];
      state.syncStatusLog[id].unshift({
        at: new Date().toISOString(),
        fromLabel: syncStatusLogLabel(prevStatus, null),
        toLabel: syncStatusLogLabel(nextStatus, ti.progressPercent),
        fromStatus: prevStatus,
        toStatus: nextStatus,
      });
      state.syncStatusLog[id] = state.syncStatusLog[id].slice(0, 10);
      state.syncStatusSnapshot[id] = nextStatus;
      refreshSyncLogPanel(id);
    }
  }
}

function buildFolderListHtml(folders) {
  if (!folders.length) {
    return `<p class="hint small folder-list-empty">Geen mappen geladen.</p>`;
  }
  return `<div class="folder-list-compact">${folders
    .map((f) => {
      const label =
        f.label && f.label !== f.id ? ` <span class="folder-label">${escapeHtml(f.label)}</span>` : "";
      return `<details class="folder-item-compact">
        <summary><code>${escapeHtml(f.id)}</code>${label}</summary>
        <p class="folder-path mono wrap">${escapeHtml(f.path || "—")}</p>
      </details>`;
    })
    .join("")}</div>`;
}

async function refreshInstanceFolders(instanceId) {
  const data = await pbRequest(`/api/syncms/instances/${encodeURIComponent(instanceId)}/folders`);
  if (data.folders) state.foldersByInstance[instanceId] = data.folders;
  const el = document.getElementById("detail-folder-config");
  if (el && state.selectedInstanceId === instanceId) {
    el.innerHTML = buildFolderListHtml(data.folders || []);
  }
  return data;
}

function renderInstanceStatsPanel(inst) {
  const panel = document.getElementById("instance-stats");
  if (!panel) return;

  if (!inst) {
    panel.innerHTML = `<p class="hint">Mappen en transfer-statistieken verschijnen hier na selectie.</p>`;
    return;
  }

  const folders = state.foldersByInstance[inst.id] || [];
  const foldersHtml = buildFolderListHtml(folders);

  panel.innerHTML = `
    <h3 class="stats-col-title">${escapeHtml(inst.name)}</h3>
    <section class="instance-stats-block">
      <h4 class="detail-subhead compact">Syncthing-mappen</h4>
      <div id="detail-folder-config">${foldersHtml}</div>
      <button type="button" class="btn ghost btn-compact" id="detail-btn-refresh-folders">Vernieuw mappenlijst</button>
    </section>
    <section class="instance-stats-block">
      <h4 class="detail-subhead compact">Transfer</h4>
      <div id="instance-stats-body"><p class="hint small">Laden…</p></div>
      <button type="button" class="btn ghost btn-compact" id="instance-stats-refresh">Vernieuw statistieken</button>
      <button type="button" class="btn ghost btn-compact" id="btn-sync-status-log" aria-expanded="false">Logging</button>
      <div id="sync-status-log-panel" class="sync-log-panel" hidden>
        <p class="hint tiny">Laatste 10 sync-statuswijzigingen (Syncthing, via topology).</p>
        <div id="sync-status-log-body">${buildSyncStatusLogHtml(inst.id)}</div>
      </div>
    </section>`;

  document.getElementById("detail-btn-refresh-folders")?.addEventListener("click", async () => {
    const btn = document.getElementById("detail-btn-refresh-folders");
    if (btn) btn.disabled = true;
    try {
      await refreshInstanceFolders(inst.id);
    } catch (err) {
      alert(`Mappenlijst: ${err.message}`);
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  document.getElementById("instance-stats-refresh")?.addEventListener("click", () => {
    delete state.instanceTransferStats[inst.id];
    loadAndShowInstanceStats(inst, true);
  });

  document.getElementById("btn-sync-status-log")?.addEventListener("click", () => {
    const panel = document.getElementById("sync-status-log-panel");
    const btn = document.getElementById("btn-sync-status-log");
    if (!panel || !btn) return;
    const open = panel.hidden;
    panel.hidden = !open;
    btn.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) refreshSyncLogPanel(inst.id);
  });

  if (!state.foldersByInstance[inst.id]?.length) {
    refreshInstanceFolders(inst.id).catch(() => {});
  }

  loadAndShowInstanceStats(inst, false);
}

async function loadAndShowInstanceStats(inst, force) {
  const body = document.getElementById("instance-stats-body");
  if (!body || state.selectedInstanceId !== inst.id) return;

  const cached = state.instanceTransferStats[inst.id];
  if (!force && cached?.stats) {
    body.innerHTML = renderInstanceStatsBody(cached.stats);
    return;
  }

  body.innerHTML = `<p class="hint small">Laden…</p>`;
  try {
    const stats = await loadInstanceTransferStats(inst.id);
    if (state.selectedInstanceId !== inst.id) return;
    state.instanceTransferStats[inst.id] = { stats, fetchedAt: Date.now() };
    body.innerHTML = renderInstanceStatsBody(stats);
  } catch (err) {
    if (state.selectedInstanceId !== inst.id) return;
    body.innerHTML = `<p class="hint small detail-error">${escapeHtml(err.message)}</p>`;
  }
}

function bucketKey(d, range) {
  const t = d.getTime();
  if (range === "8h" || range === "24h") {
    const m = new Date(t);
    m.setMinutes(0, 0, 0);
    return m.toISOString();
  }
  if (range === "7d") {
    const m = new Date(t);
    m.setHours(Math.floor(m.getHours() / 6) * 6, 0, 0, 0);
    return m.toISOString();
  }
  if (range === "month") {
    const m = new Date(t);
    m.setHours(0, 0, 0, 0);
    return m.toISOString();
  }
  const m = new Date(t);
  m.setDate(1);
  m.setHours(0, 0, 0, 0);
  return m.toISOString();
}

function labelForBucket(iso, range) {
  const d = new Date(iso);
  if (range === "all") {
    return d.toLocaleDateString(undefined, { month: "short", year: "2-digit" });
  }
  if (range === "month") {
    return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  }
  return d.toLocaleString(undefined, { hour: "2-digit", minute: "2-digit" });
}

async function loadSamplesForRange(range) {
  const from = rangeStart(range);
  const useHourly = range === "month" || range === "all";
  const collection = useHourly ? "transfer_hourly" : "transfer_samples";
  const filter =
    from.getTime() > 0
      ? `${useHourly ? "bucket_start" : "recorded_at"} >= "${toPbFilterDate(from)}"`
      : "";
  const rows = await listAll(collection, {
    filter,
    sort: useHourly ? "bucket_start" : "recorded_at",
  });
  return { rows, useHourly };
}

function aggregateChartData(rows, useHourly, range) {
  const buckets = new Map();
  for (const row of rows) {
    const raw = useHourly ? row.bucket_start : row.recorded_at;
    const dt = parsePbDate(raw);
    if (!dt) continue;
    const key = bucketKey(dt, range);
    const cur = buckets.get(key) || { in: 0, out: 0, inSpeed: 0, outSpeed: 0, n: 0 };
    if (useHourly) {
      cur.in += Number(row.in_bytes_delta) || 0;
      cur.out += Number(row.out_bytes_delta) || 0;
    } else {
      cur.in += Number(row.in_bytes_delta) || 0;
      cur.out += Number(row.out_bytes_delta) || 0;
      cur.inSpeed += Number(row.in_speed_bps) || 0;
      cur.outSpeed += Number(row.out_speed_bps) || 0;
      cur.n += 1;
    }
    buckets.set(key, cur);
  }
  const keys = [...buckets.keys()].sort();
  const labels = keys.map((k) => labelForBucket(k, range));
  const inData = keys.map((k) => buckets.get(k).in);
  const outData = keys.map((k) => buckets.get(k).out);
  const inSpeed = keys.map((k) => {
    const b = buckets.get(k);
    return b.n ? b.inSpeed / b.n : 0;
  });
  const outSpeed = keys.map((k) => {
    const b = buckets.get(k);
    return b.n ? b.outSpeed / b.n : 0;
  });
  return { labels, inData, outData, inSpeed, outSpeed };
}

function floorMinuteMs(d) {
  const m = new Date(d.getTime());
  m.setSeconds(0, 0);
  return m.getTime();
}

function buildMinuteSpeedSeries(rows) {
  const end = new Date();
  end.setSeconds(0, 0);
  const endMs = end.getTime();
  const startMs = endMs - (SPEED_HISTORY_MINUTES - 1) * 60 * 1000;

  const byMinute = new Map();
  for (const row of rows) {
    const dt = parsePbDate(row.recorded_at);
    if (!dt) continue;
    const key = floorMinuteMs(dt);
    if (key < startMs || key > endMs) continue;
    const cur = byMinute.get(key) || { in: 0, out: 0, n: 0 };
    cur.in += Number(row.in_speed_bps) || 0;
    cur.out += Number(row.out_speed_bps) || 0;
    cur.n += 1;
    byMinute.set(key, cur);
  }

  const labels = [];
  const inSpeed = [];
  const outSpeed = [];
  for (let i = 0; i < SPEED_HISTORY_MINUTES; i++) {
    const t = startMs + i * 60 * 1000;
    labels.push(
      new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    );
    const slot = byMinute.get(t);
    if (slot && slot.n > 0) {
      inSpeed.push(slot.in / slot.n);
      outSpeed.push(slot.out / slot.n);
    } else {
      inSpeed.push(0);
      outSpeed.push(0);
    }
  }
  return { labels, inSpeed, outSpeed };
}

function chartColors() {
  return {
    in: "rgba(71, 198, 255, 0.85)",
    out: "rgba(94, 228, 168, 0.85)",
    inFill: "rgba(71, 198, 255, 0.25)",
    outFill: "rgba(94, 228, 168, 0.2)",
    grid: "rgba(154, 163, 184, 0.15)",
    text: "#9aa3b8",
  };
}

function renderTransferChart(data) {
  const c = chartColors();
  const transferCtx = document.getElementById("transfer-chart");

  if (state.transferChart) state.transferChart.destroy();

  state.transferChart = new Chart(transferCtx, {
    type: "bar",
    data: {
      labels: data.labels,
      datasets: [
        {
          label: "Download (in)",
          data: data.inData,
          backgroundColor: c.in,
          borderRadius: 4,
        },
        {
          label: "Upload (out)",
          data: data.outData,
          backgroundColor: c.out,
          borderRadius: 4,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { ticks: { color: c.text, maxRotation: 45 }, grid: { color: c.grid } },
        y: {
          ticks: {
            color: c.text,
            callback: (v) => formatBytes(v),
          },
          grid: { color: c.grid },
        },
      },
      plugins: {
        legend: { labels: { color: c.text } },
        tooltip: {
          callbacks: {
            label: (ctx) => `${ctx.dataset.label}: ${formatBytes(ctx.raw)}`,
          },
        },
      },
    },
  });
}

function renderSpeedChart8h(data) {
  const c = chartColors();
  const speedCtx = document.getElementById("speed-chart");

  if (state.speedChart) state.speedChart.destroy();

  state.speedChart = new Chart(speedCtx, {
    type: "line",
    data: {
      labels: data.labels,
      datasets: [
        {
          label: "Download snelheid",
          data: data.inSpeed,
          borderColor: c.in,
          backgroundColor: c.inFill,
          fill: true,
          tension: 0.25,
          pointRadius: 0,
          pointHoverRadius: 4,
          borderWidth: 2,
        },
        {
          label: "Upload snelheid",
          data: data.outSpeed,
          borderColor: c.out,
          backgroundColor: c.outFill,
          fill: true,
          tension: 0.25,
          pointRadius: 0,
          pointHoverRadius: 4,
          borderWidth: 2,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      scales: {
        x: {
          ticks: {
            color: c.text,
            maxRotation: 0,
            autoSkip: true,
            maxTicksLimit: 12,
          },
          grid: { color: c.grid },
        },
        y: {
          ticks: {
            color: c.text,
            callback: (v) => formatSpeed(v),
          },
          grid: { color: c.grid },
        },
      },
      plugins: {
        legend: { labels: { color: c.text } },
        tooltip: {
          callbacks: {
            title: (items) => (items[0] ? `Minuut ${items[0].label}` : ""),
            label: (ctx) => `${ctx.dataset.label}: ${formatSpeed(ctx.raw)}`,
          },
        },
      },
    },
  });
}

function layoutTopologyNodes(instanceIds) {
  const layout = {};
  const n = instanceIds.length;
  const cx = TOPO_W / 2;
  const cy = TOPO_H / 2;
  const r = n <= 1 ? 0 : Math.max(180, Math.min(TOPO_W, TOPO_H) * 0.34);

  for (let i = 0; i < n; i++) {
    const id = instanceIds[i];
    if (n === 1) {
      layout[id] = { x: cx, y: cy };
    } else {
      const a = (2 * Math.PI * i) / n - Math.PI / 2;
      layout[id] = { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
    }
  }
  return layout;
}

function ellipseRadiusInDirection(rx, ry, ux, uy) {
  const denom = Math.sqrt((ry * ux) ** 2 + (rx * uy) ** 2);
  if (denom < 1e-6) return Math.max(rx, ry);
  return (rx * ry) / denom;
}

/** Chip half-size in SVG viewBox units (measured from DOM after layout). */
function getChipRadii(instanceId) {
  const fallback = { rx: 62, ry: 40 };
  const board = document.getElementById("topology-board");
  const chip = document.querySelector(`.topo-chip[data-id="${CSS.escape(instanceId)}"]`);
  if (!board || !chip) return fallback;
  const br = board.getBoundingClientRect();
  const cr = chip.getBoundingClientRect();
  if (br.width < 1 || br.height < 1) return fallback;
  return {
    rx: Math.max(26, (cr.width / br.width) * TOPO_W * 0.5 + 1),
    ry: Math.max(22, (cr.height / br.height) * TOPO_H * 0.5 + 1),
  };
}

function trimSegmentToChips(x1, y1, x2, y2, fromId, toId) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const fromR = getChipRadii(fromId);
  const toR = getChipRadii(toId);
  const pad1 = ellipseRadiusInDirection(fromR.rx, fromR.ry, ux, uy);
  const pad2 = ellipseRadiusInDirection(toR.rx, toR.ry, -ux, -uy);
  return {
    x1: x1 + ux * pad1,
    y1: y1 + uy * pad1,
    x2: x2 - ux * pad2,
    y2: y2 - uy * pad2,
  };
}

function quadMid(x1, y1, cx, cy, x2, y2) {
  const t = 0.5;
  const u = 1 - t;
  return {
    x: u * u * x1 + 2 * u * t * cx + t * t * x2,
    y: u * u * y1 + 2 * u * t * cy + t * t * y2,
  };
}

function folderLinkColor(link) {
  if (link.kind === "connection" || !link.folderId) {
    return "hsla(210, 18%, 52%, 0.75)";
  }
  const hues = [198, 158, 278, 32, 318, 120];
  let hash = 0;
  const s = String(link.folderId);
  for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) | 0;
  const hue = hues[Math.abs(hash) % hues.length];
  return `hsla(${hue}, 72%, 58%, 0.92)`;
}

function renderTopologyEdges(links, layout) {
  const svg = document.getElementById("topology-edges");
  const pairCount = {};
  const defs = `
    <defs>
      <marker id="sync-arrow-end" viewBox="0 0 10 10" refX="9.5" refY="5" markerUnits="userSpaceOnUse" markerWidth="11" markerHeight="11" orient="auto">
        <path d="M 0 0 L 10 5 L 0 10 Z" fill="context-stroke"></path>
      </marker>
      <marker id="sync-arrow-start" viewBox="0 0 10 10" refX="9.5" refY="5" markerUnits="userSpaceOnUse" markerWidth="11" markerHeight="11" orient="auto-start-reverse">
        <path d="M 0 0 L 10 5 L 0 10 Z" fill="context-stroke"></path>
      </marker>
    </defs>`;

  if (!links.length) {
    svg.innerHTML = defs;
    return;
  }

  const paths = [];
  const labels = [];
  const pairTotals = {};
  for (let t = 0; t < links.length; t++) {
    const pk = [links[t].from, links[t].to].sort().join("|");
    pairTotals[pk] = (pairTotals[pk] || 0) + 1;
  }

  for (let i = 0; i < links.length; i++) {
    const link = links[i];
    const from = layout[link.from];
    const to = layout[link.to];
    if (!from || !to) continue;

    const pairKey = [link.from, link.to].sort().join("|");
    const idx = pairCount[pairKey] || 0;
    pairCount[pairKey] = idx + 1;
    const total = pairTotals[pairKey] || 1;
    const curve = (idx - (total - 1) / 2) * 55;

    let sx = from.x;
    let sy = from.y;
    let ex = to.x;
    let ey = to.y;

    if (link.aToB && !link.bToA) {
      const seg = trimSegmentToChips(from.x, from.y, to.x, to.y, link.from, link.to);
      sx = seg.x1;
      sy = seg.y1;
      ex = seg.x2;
      ey = seg.y2;
    } else if (link.bToA && !link.aToB) {
      const seg = trimSegmentToChips(to.x, to.y, from.x, from.y, link.to, link.from);
      sx = seg.x1;
      sy = seg.y1;
      ex = seg.x2;
      ey = seg.y2;
    } else {
      const seg = trimSegmentToChips(from.x, from.y, to.x, to.y, link.from, link.to);
      sx = seg.x1;
      sy = seg.y1;
      ex = seg.x2;
      ey = seg.y2;
    }

    const mx = (sx + ex) / 2;
    const my = (sy + ey) / 2;
    const dx = ex - sx;
    const dy = ey - sy;
    const len = Math.hypot(dx, dy) || 1;
    const cx = mx - (dy / len) * curve;
    const cy = my + (dx / len) * curve;
    const color = folderLinkColor(link);

    const markers = link.bidirectional
      ? 'marker-start="url(#sync-arrow-start)" marker-end="url(#sync-arrow-end)"'
      : 'marker-end="url(#sync-arrow-end)"';

    const dash = link.kind === "connection" ? ' stroke-dasharray="8 6" opacity="0.75"' : "";
    paths.push(
      `<path d="M ${sx} ${sy} Q ${cx} ${cy} ${ex} ${ey}" stroke="${color}" stroke-width="2.5" stroke-linecap="round" ${markers}${dash}></path>`
    );

    const mid = quadMid(sx, sy, cx, cy, ex, ey);
    labels.push(
      `<text class="link-label" x="${mid.x}" y="${mid.y - 6}" text-anchor="middle">${escapeHtml(link.folderLabel)}</text>`
    );
  }

  svg.innerHTML = defs + paths.join("") + labels.join("");
}

function selectInstance(instanceId) {
  state.selectedInstanceId = instanceId;
  document.querySelectorAll(".topo-chip").forEach((el) => {
    el.classList.toggle("selected", el.dataset.id === instanceId);
    el.setAttribute("aria-pressed", el.dataset.id === instanceId ? "true" : "false");
  });
  renderInstanceDetail();
}

function syncBadgeClass(syncStatus) {
  switch (syncStatus) {
    case "syncing":
      return "sync-active";
    case "scanning":
      return "sync-scan";
    case "uptodate":
      return "sync-ok";
    case "standby":
      return "sync-standby";
    default:
      return "sync-unknown";
  }
}

function renderTopologyNodes(instances, layout) {
  const root = document.getElementById("topology-nodes");
  root.innerHTML = instances
    .map((inst) => {
      const pos = layout[inst.id];
      if (!pos) return "";
      const online = inst.online;
      const selected = inst.id === state.selectedInstanceId;
      const left = (pos.x / TOPO_W) * 100;
      const top = (pos.y / TOPO_H) * 100;
      const sync = state.syncByInstanceId[inst.id] || {};
      const syncLabel = sync.syncLabel || "—";
      const syncStatus = sync.syncStatus || "unknown";
      const syncTitle = online ? syncLabel : "Offline";
      const title = `${inst.name} — ${syncTitle}`;
      const syncBadge =
        online && syncLabel
          ? `<span class="badge sync ${syncBadgeClass(syncStatus)}">${escapeHtml(syncLabel)}</span>`
          : "";
      return `
      <button
        type="button"
        class="topo-chip${selected ? " selected" : ""}"
        data-id="${inst.id}"
        style="left:${left}%;top:${top}%"
        aria-pressed="${selected ? "true" : "false"}"
        title="${escapeHtml(title)}"
      >
        <span class="topo-chip-name">${escapeHtml(inst.name)}</span>
        <span class="topo-chip-badges">
          <span class="badge ${online ? "ok" : "off"}">${online ? "Online" : "Offline"}</span>
          ${syncBadge}
        </span>
      </button>`;
    })
    .join("");

  root.querySelectorAll(".topo-chip").forEach((btn) => {
    btn.addEventListener("click", () => selectInstance(btn.dataset.id));
  });
}

let pairSourceInstanceId = null;

function openPairDevicesDialog(inst) {
  pairSourceInstanceId = inst.id;
  const listEl = document.getElementById("pair-partners-list");
  const leadEl = document.getElementById("pair-dialog-lead");
  const titleEl = document.getElementById("pair-dialog-title");
  const errEl = document.getElementById("pair-dialog-error");
  if (titleEl) titleEl.textContent = `Devices koppelen — ${inst.name}`;
  if (leadEl) {
    leadEl.textContent =
      "Vink partners aan. Sync-MS voegt ontbrekende remote devices toe op beide Syncthing-configs (API-key moet config mogen wijzigen).";
  }
  if (errEl) {
    errEl.hidden = true;
    errEl.textContent = "";
  }

  const others = state.instances.filter((i) => i.id !== inst.id && i.enabled !== false);
  if (listEl) {
    if (!others.length) {
      listEl.innerHTML = `<li class="hint small">Geen andere enabled instances.</li>`;
    } else {
      listEl.innerHTML = others
        .map((i) => {
          const sid = i.syncthing_id ? "" : " (syncthing_id onbekend)";
          return `<li><label class="share-partner"><input type="checkbox" name="pair-partner" value="${escapeAttr(i.id)}" /> ${escapeHtml(i.name)}${escapeHtml(sid)}</label></li>`;
        })
        .join("");
    }
  }

  pairDialog?.showModal();
}

async function submitPairDevices() {
  const errEl = document.getElementById("pair-dialog-error");
  const sourceId = pairSourceInstanceId;
  const source = state.instances.find((i) => i.id === sourceId);
  if (!sourceId || !source) {
    if (errEl) {
      errEl.textContent = "Geen bron-instance geselecteerd.";
      errEl.hidden = false;
    }
    return;
  }

  const partnerIds = [];
  document.querySelectorAll('#pair-partners-list input[name="pair-partner"]:checked').forEach((el) => {
    partnerIds.push(el.value);
  });
  if (!partnerIds.length) {
    if (errEl) {
      errEl.textContent = "Selecteer minimaal één partner.";
      errEl.hidden = false;
    }
    return;
  }

  const btn = document.getElementById("btn-pair-submit");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Koppelen…";
  }
  if (errEl) errEl.hidden = true;

  try {
    const res = await pbRequest("/api/syncms/auto-pair-devices", {
      method: "POST",
      body: JSON.stringify({
        source_instance_id: sourceId,
        partner_instance_ids: partnerIds,
      }),
    });
    if (!res.ok) {
      const fail = (res.steps || []).filter((s) => s.ok === false);
      const extra = fail.map((s) => `${s.instance || s.from}: ${s.error || ""}`).join("\n");
      if (errEl) {
        errEl.textContent = (res.error || "Koppelen mislukt") + (extra ? " — " + extra : "");
        errEl.hidden = false;
      }
      return;
    }
    pairDialog?.close();
    alert(
      `${source.name}: ${res.pairsLinked} gekoppeld, ${res.pairsAlreadyLinked} had al een device-entry.`
    );
    await refresh();
  } catch (err) {
    if (errEl) {
      errEl.textContent = err.message;
      errEl.hidden = false;
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Koppelen";
    }
  }
}

function renderInstanceDetail() {
  const panel = document.getElementById("instance-detail");
  const inst = state.instances.find((i) => i.id === state.selectedInstanceId);

  if (!inst) {
    panel.innerHTML = `<p class="hint">Selecteer een instance in het diagram.</p>`;
    renderInstanceStatsPanel(null);
    return;
  }

  const topoErr = state.topoErrors[inst.id] || state.topoErrors.__hook;
  const guiUrl = (inst.base_url || "").trim();
  const online = inst.online;

  panel.innerHTML = `
    <div class="detail-head">
      <h3>${escapeHtml(inst.name)}</h3>
      <span class="badge ${online ? "ok" : "off"}">${online ? "Online" : "Offline"}</span>
    </div>
    <dl class="stat-grid detail-stats">
      <dt>Totaal in</dt><dd>${formatBytes(bytesAlltimeIn(inst))}</dd>
      <dt>Totaal out</dt><dd>${formatBytes(bytesAlltimeOut(inst))}</dd>
      <dt>Snelheid in</dt><dd>${formatSpeed(inst.in_speed_bps)}</dd>
      <dt>Snelheid out</dt><dd>${formatSpeed(inst.out_speed_bps)}</dd>
      <dt>Versie</dt><dd>${escapeHtml(inst.version || "—")}</dd>
      <dt>Syncthing ID</dt><dd class="mono">${escapeHtml(inst.syncthing_id ? `${inst.syncthing_id.slice(0, 11)}…` : "—")}</dd>
      <dt>Laatst gezien</dt><dd>${formatWhen(inst.last_seen)}</dd>
      <dt>API URL</dt><dd class="mono wrap">${escapeHtml(guiUrl || "—")}</dd>
    </dl>
    <p class="hint small">Totaal in/out = som van alle metingen sinds monitoring (niet alleen laatste poll).</p>
    ${
      inst.last_error || topoErr
        ? `<p class="hint small detail-error">${escapeHtml(inst.last_error || topoErr)}</p>`
        : ""
    }
    <h4 class="detail-subhead">Syncthing-devices</h4>
    <p class="hint small">Koppel deze instance aan gekozen partners (remote device in Syncthing-config).</p>
    <button type="button" class="btn ghost btn-compact" id="detail-btn-pair-devices">Devices koppelen…</button>
    <div class="detail-actions">
      ${
        guiUrl
          ? `<a class="btn primary" href="${escapeHtml(guiUrl)}" target="_blank" rel="noopener noreferrer">Open Syncthing GUI</a>`
          : ""
      }
      <button type="button" class="btn ghost" id="detail-btn-edit">Bewerken</button>
      <button type="button" class="btn danger" id="detail-btn-delete">Verwijderen</button>
    </div>`;

  renderInstanceStatsPanel(inst);

  document.getElementById("detail-btn-pair-devices")?.addEventListener("click", () => openPairDevicesDialog(inst));
  document.getElementById("detail-btn-edit")?.addEventListener("click", () => openDialog(inst));
  document.getElementById("detail-btn-delete")?.addEventListener("click", async () => {
    if (!confirm(`Instance "${inst.name}" verwijderen?`)) return;
    await pbRequest(`/api/collections/instances/records/${inst.id}`, { method: "DELETE" });
    state.selectedInstanceId = null;
    await refresh();
  });
}

/** Houd vorige topology-lijnen zichtbaar terwijl nieuwe data laadt. */
function updateOverviewWhileTopologyLoading() {
  const split = document.getElementById("overview-split");
  const empty = document.getElementById("topology-empty");

  if (!state.instances.length) {
    split.hidden = true;
    empty.hidden = false;
    empty.textContent = "Nog geen instances. Voeg Syncthing-installaties toe (URL + API key).";
    state.selectedInstanceId = null;
    return;
  }

  split.hidden = false;
  empty.hidden = true;

  const ids = state.instances.map((i) => i.id);
  state.nodeLayout = layoutTopologyNodes(ids);

  if (!state.selectedInstanceId || !ids.includes(state.selectedInstanceId)) {
    state.selectedInstanceId = state.instances[0].id;
  }

  renderTopologyNodes(state.instances, state.nodeLayout);
  const links = state.topology?.links || [];
  if (links.length) {
    requestAnimationFrame(() => {
      renderTopologyEdges(links, state.nodeLayout);
    });
  }
  renderInstanceDetail();
}

async function loadTopology() {
  try {
    return await pbRequest("/api/syncms/topology");
  } catch (err) {
    console.warn("topology", err);
    return {
      instances: [],
      links: [],
      diagnostics: {
        hints: [
          "Topologie API mislukt (" +
            err.message +
            "). Controleer of de container de nieuwste pb_hooks heeft (image rebuild).",
        ],
      },
    };
  }
}

function renderOverview(topology) {
  const split = document.getElementById("overview-split");
  const empty = document.getElementById("topology-empty");

  if (!state.instances.length) {
    split.hidden = true;
    empty.hidden = false;
    empty.textContent = "Nog geen instances. Voeg Syncthing-installaties toe (URL + API key).";
    state.selectedInstanceId = null;
    return;
  }

  split.hidden = false;
  empty.hidden = true;

  const ids = state.instances.map((i) => i.id);
  state.nodeLayout = layoutTopologyNodes(ids);
  state.topology = topology || { links: [] };

  recordSyncStatusChanges(topology.instances || []);

  state.topoErrors = {};
  state.foldersByInstance = {};
  state.syncByInstanceId = {};
  for (const ti of topology.instances || []) {
    if (ti.error) state.topoErrors[ti.instanceId] = ti.error;
    state.foldersByInstance[ti.instanceId] = ti.folders || [];
    state.syncByInstanceId[ti.instanceId] = {
      syncStatus: ti.syncStatus || "unknown",
      syncLabel: ti.syncLabel || "—",
      progressPercent: ti.progressPercent,
    };
  }
  if (topology.diagnostics?.hookError) {
    state.topoErrors.__hook = topology.diagnostics.hookError;
  }

  if (!state.selectedInstanceId || !ids.includes(state.selectedInstanceId)) {
    state.selectedInstanceId = state.instances[0].id;
  }

  renderTopologyNodes(state.instances, state.nodeLayout);
  requestAnimationFrame(() => {
    renderTopologyEdges(state.topology.links || [], state.nodeLayout);
  });
  renderInstanceDetail();

  const diagEl = document.getElementById("topology-diag");
  const hints = topology.diagnostics?.hints || [];
  if (hints.length && (state.topology.links || []).length === 0) {
    diagEl.hidden = false;
    diagEl.textContent = hints.join(" ");
  } else if (hints.length) {
    diagEl.hidden = false;
    diagEl.textContent = hints.join(" ");
  } else {
    diagEl.hidden = true;
    diagEl.textContent = "";
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(s) {
  return escapeHtml(String(s));
}

function formatWhen(s) {
  const d = parsePbDate(s);
  if (!d) return "—";
  return d.toLocaleString();
}

/** Cumulative bytes since Sync-MS monitoring (sum of sample deltas). */
function bytesAlltimeIn(inst) {
  if (inst.in_bytes_alltime != null && !Number.isNaN(Number(inst.in_bytes_alltime))) {
    return Number(inst.in_bytes_alltime);
  }
  return Number(inst.in_bytes_total) || 0;
}

function bytesAlltimeOut(inst) {
  if (inst.out_bytes_alltime != null && !Number.isNaN(Number(inst.out_bytes_alltime))) {
    return Number(inst.out_bytes_alltime);
  }
  return Number(inst.out_bytes_total) || 0;
}

function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 1000);
}

function bindClick(id, handler) {
  const el = document.getElementById(id);
  if (!el) {
    console.warn(`Sync-MS: element #${id} ontbreekt`);
    return;
  }
  el.addEventListener("click", handler);
}

async function buildConfigBackup() {
  try {
    return await pbRequest("/api/syncms/config/backup");
  } catch (err) {
    console.warn("backup API unavailable, using PocketBase records", err);
    const rows = await listAll("instances", { sort: "name" });
    return {
      syncms_backup_version: 1,
      exported_at: new Date().toISOString(),
      instances: rows.map((r) => ({
        name: String(r.name || "").trim(),
        base_url: String(r.base_url || "").trim(),
        api_key: String(r.api_key || "").trim(),
        enabled: r.enabled !== false,
      })),
    };
  }
}

async function restoreConfigPayload(parsed) {
  try {
    return await pbRequest("/api/syncms/config/restore", {
      method: "POST",
      body: JSON.stringify(parsed),
    });
  } catch (err) {
    console.warn("restore API unavailable, using PocketBase records", err);
    if (parsed.syncms_backup_version !== 1 || !Array.isArray(parsed.instances)) {
      throw new Error("Ongeldig backup-bestand (syncms_backup_version: 1 vereist).");
    }
    const existing = await listAll("instances", { sort: "name" });
    const byName = {};
    for (const r of existing) {
      const key = String(r.name || "")
        .trim()
        .toLowerCase();
      if (key) byName[key] = r;
    }
    let created = 0;
    let updated = 0;
    let skipped = 0;
    for (const item of parsed.instances) {
      const name = String(item.name || "").trim();
      const base_url = String(item.base_url || "").trim();
      const api_key = String(item.api_key || "").trim();
      const enabled = item.enabled !== false;
      if (!name || !base_url || !api_key) {
        skipped++;
        continue;
      }
      const key = name.toLowerCase();
      const prev = byName[key];
      if (prev) {
        await pbRequest(`/api/collections/instances/records/${prev.id}`, {
          method: "PATCH",
          body: JSON.stringify({ name, base_url, api_key, enabled }),
        });
        updated++;
      } else {
        await pbRequest("/api/collections/instances/records", {
          method: "POST",
          body: JSON.stringify({
            name,
            base_url,
            api_key,
            enabled,
            last_event_id: 0,
            online: false,
            sample_count: 0,
          }),
        });
        created++;
      }
    }
    return { ok: true, created, updated, skipped };
  }
}

function setFooterStatus(text) {
  const footer = document.getElementById("footer-status");
  if (footer) footer.textContent = text;
}

const dialog = document.getElementById("instance-dialog");
const form = document.getElementById("instance-form");
const pairDialog = document.getElementById("pair-devices-dialog");

function setTestConnectionStatus(kind, message) {
  const el = document.getElementById("test-connection-status");
  if (!message) {
    el.hidden = true;
    el.textContent = "";
    el.className = "test-status";
    return;
  }
  el.hidden = false;
  el.className = `test-status ${kind}`;
  el.textContent = message;
}

function openDialog(inst) {
  state.editingId = inst?.id || null;
  document.getElementById("dialog-title").textContent = inst
    ? "Instance bewerken"
    : "Syncthing instance";
  form.name.value = inst?.name || "";
  form.base_url.value = inst?.base_url || "";
  form.api_key.value = inst?.api_key || "";
  form.disk_probe_host.value = inst?.disk_probe_host || "";
  form.enabled.checked = inst ? inst.enabled !== false : true;
  setTestConnectionStatus("", "");
  dialog.showModal();
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = {
    name: form.name.value.trim(),
    base_url: form.base_url.value.trim(),
    api_key: form.api_key.value.trim(),
    disk_probe_host: form.disk_probe_host.value.trim(),
    enabled: form.enabled.checked,
  };
  if (state.editingId) {
    await pbRequest(`/api/collections/instances/records/${state.editingId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
  } else {
    await pbRequest("/api/collections/instances/records", {
      method: "POST",
      body: JSON.stringify({
        ...body,
        last_event_id: 0,
        online: false,
        sample_count: 0,
      }),
    });
  }
  dialog.close();
  await refresh();
});

document.getElementById("btn-cancel").addEventListener("click", () => dialog.close());
document.getElementById("btn-add-instance").addEventListener("click", () => openDialog(null));
document.getElementById("btn-refresh").addEventListener("click", () => refresh());
document.getElementById("btn-pair-cancel")?.addEventListener("click", () => pairDialog?.close());
document.getElementById("btn-pair-submit")?.addEventListener("click", () => submitPairDevices());

const restoreInput = document.getElementById("config-restore-file");

bindClick("btn-config-backup", async (ev) => {
  const btn = ev.currentTarget;
  btn.disabled = true;
  const prevLabel = btn.textContent;
  btn.textContent = "Backup…";
  setFooterStatus("Config backup voorbereiden…");
  try {
    const data = await buildConfigBackup();
    const stamp = new Date().toISOString().slice(0, 10);
    downloadJson(`sync-ms-config-${stamp}.json`, data);
    setFooterStatus(`Backup gedownload (${data.instances?.length ?? 0} instance(s)).`);
  } catch (err) {
    setFooterStatus(`Backup mislukt: ${err.message}`);
    alert(`Backup mislukt: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = prevLabel;
  }
});

bindClick("btn-config-restore", () => {
  if (!restoreInput) {
    alert("Restore niet beschikbaar (bestandskiezer ontbreekt).");
    return;
  }
  restoreInput.value = "";
  restoreInput.click();
});

if (restoreInput) {
  restoreInput.addEventListener("change", async () => {
    const file = restoreInput.files?.[0];
    if (!file) return;
    let parsed;
    try {
      parsed = JSON.parse(await file.text());
    } catch (_) {
      alert("Geen geldig JSON-bestand.");
      return;
    }
    const n = Array.isArray(parsed.instances) ? parsed.instances.length : 0;
    if (
      !confirm(
        `Restore uit "${file.name}"?\n\n${n} instance(s). Bestaande namen worden overschreven (URL + API key). Statistieken blijven behouden.`
      )
    ) {
      return;
    }
    setFooterStatus("Config restore…");
    try {
      const res = await restoreConfigPayload(parsed);
      if (res.ok === false) {
        alert(res.error || "Restore mislukt");
        setFooterStatus("Restore mislukt.");
        return;
      }
      const msg = `Restore OK — ${res.created} nieuw, ${res.updated} bijgewerkt${res.skipped ? `, ${res.skipped} overgeslagen` : ""}.`;
      setFooterStatus(msg);
      alert(msg);
      await refresh();
    } catch (err) {
      setFooterStatus(`Restore mislukt: ${err.message}`);
      alert(`Restore mislukt: ${err.message}`);
    }
  });
}

document.getElementById("btn-test-connection").addEventListener("click", async () => {
  const baseUrl = form.base_url.value.trim();
  const apiKey = form.api_key.value.trim();
  if (!baseUrl || !apiKey) {
    setTestConnectionStatus("err", "Vul eerst URL en API key in.");
    return;
  }
  setTestConnectionStatus("busy", "Verbinding testen…");
  try {
    const res = await pbRequest("/api/syncms/test-connection", {
      method: "POST",
      body: JSON.stringify({ base_url: baseUrl, api_key: apiKey }),
    });
    if (res.ok) {
      const idHint = res.deviceId ? ` · ${res.deviceId.slice(0, 11)}…` : "";
      setTestConnectionStatus("ok", `Verbinding OK — Syncthing ${res.version}${idHint}`);
    } else {
      setTestConnectionStatus("err", res.error || "Verbinding mislukt");
    }
  } catch (err) {
    setTestConnectionStatus("err", err.message);
  }
});

document.getElementById("chart-instance").addEventListener("change", async (e) => {
  state.chartInstance = e.target.value;
  await loadCharts();
});

document.querySelectorAll(".segmented button").forEach((btn) => {
  btn.addEventListener("click", async () => {
    document.querySelectorAll(".segmented button").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    state.range = btn.dataset.range;
    await loadCharts();
  });
});

function syncInstanceSelect() {
  const sel = document.getElementById("chart-instance");
  const cur = state.chartInstance;
  sel.innerHTML =
    '<option value="">Alle instances</option>' +
    state.instances
      .map((i) => `<option value="${i.id}">${escapeHtml(i.name)}</option>`)
      .join("");
  sel.value = cur;
}

function filterSamplesByInstance(rows) {
  if (!state.chartInstance) return rows;
  return rows.filter((r) => r.instance === state.chartInstance);
}

function instanceNameById(id) {
  const inst = state.instances.find((i) => i.id === id);
  return inst ? inst.name : id;
}

function downsampleDiskRows(rows, range) {
  if (range === "8h" || range === "24h") return rows;
  const byHour = new Map();
  for (const row of rows) {
    const dt = parsePbDate(row.recorded_at);
    if (!dt) continue;
    const key = dt.toISOString().slice(0, 13);
    byHour.set(key, row);
  }
  return [...byHour.values()].sort(
    (a, b) => (parsePbDate(a.recorded_at)?.getTime() || 0) - (parsePbDate(b.recorded_at)?.getTime() || 0)
  );
}

function diskChartLabel(dt, range) {
  if (!dt) return "";
  if (range === "month" || range === "all" || range === "7d") {
    return dt.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  }
  return dt.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function destroyFolderDiskCharts() {
  for (const ch of state.folderDiskCharts) {
    try {
      ch.destroy();
    } catch (_) {}
  }
  state.folderDiskCharts = [];
}

function renderFolderDiskCharts(groups, range) {
  const host = document.getElementById("folder-disk-charts");
  const emptyEl = document.getElementById("folder-disk-empty");
  destroyFolderDiskCharts();
  host.innerHTML = "";

  const keys = [...groups.keys()].sort();
  if (!keys.length) {
    emptyEl.hidden = false;
    return;
  }
  emptyEl.hidden = true;

  const c = chartColors();
  const showInstance = !state.chartInstance;

  for (const key of keys) {
    const meta = groups.get(key);
    const rows = downsampleDiskRows(meta.rows, range);
    const labels = rows.map((r) => diskChartLabel(parsePbDate(r.recorded_at), range));
    const freeData = rows.map((r) => Number(r.free_bytes) || 0);

    const wrap = document.createElement("div");
    wrap.className = "folder-disk-chart-item";
    const title = document.createElement("h3");
    title.className = "folder-disk-chart-title";
    title.textContent = showInstance
      ? `${meta.instanceName} · ${meta.folderLabel}`
      : meta.folderLabel;
    const chartWrap = document.createElement("div");
    chartWrap.className = "chart-wrap chart-wrap-disk";
    const canvas = document.createElement("canvas");
    canvas.height = 100;
    chartWrap.appendChild(canvas);
    wrap.appendChild(title);
    wrap.appendChild(chartWrap);
    host.appendChild(wrap);

    const chart = new Chart(canvas, {
      type: "line",
      data: {
        labels,
        datasets: [
          {
            label: "Vrije ruimte",
            data: freeData,
            borderColor: "rgba(255, 180, 84, 0.9)",
            backgroundColor: "rgba(255, 180, 84, 0.15)",
            fill: true,
            tension: 0.2,
            pointRadius: labels.length > 120 ? 0 : 2,
            pointHoverRadius: 4,
            borderWidth: 2,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: { ticks: { color: c.text, maxRotation: 45, maxTicksLimit: 12 }, grid: { color: c.grid } },
          y: {
            ticks: { color: c.text, callback: (v) => formatBytes(v) },
            grid: { color: c.grid },
          },
        },
        plugins: {
          legend: { labels: { color: c.text } },
          tooltip: {
            callbacks: {
              label: (ctx) => `Vrij: ${formatBytes(ctx.raw)}`,
            },
          },
        },
      },
    });
    state.folderDiskCharts.push(chart);
  }
}

async function loadFolderDiskCharts() {
  const from = rangeStart(state.range);
  const filter =
    from.getTime() > 0 ? `recorded_at >= "${toPbFilterDate(from)}"` : "";
  const rows = await listAll("folder_disk_samples", { filter, sort: "recorded_at" });
  const filtered = filterSamplesByInstance(rows);

  const groups = new Map();
  for (const row of filtered) {
    const folderId = String(row.folder_id || "").trim();
    if (!folderId) continue;
    const instId = row.instance;
    const key = `${instId}\0${folderId}`;
    const label = String(row.folder_label || "").trim() || folderId;
    let g = groups.get(key);
    if (!g) {
      g = { instanceName: instanceNameById(instId), folderLabel: label, rows: [] };
      groups.set(key, g);
    }
    if (label && g.folderLabel === folderId && label !== folderId) {
      g.folderLabel = label;
    }
    g.rows.push(row);
  }

  renderFolderDiskCharts(groups, state.range);
}

async function loadTransferChartFromRows(rows, useHourly) {
  const data = aggregateChartData(filterSamplesByInstance(rows), useHourly, state.range);
  renderTransferChart(data);
}

async function loadSpeedChart8hFromRows(rows) {
  renderSpeedChart8h(buildMinuteSpeedSeries(filterSamplesByInstance(rows)));
}

async function loadCharts() {
  const useHourly = state.range === "month" || state.range === "all";
  if (useHourly) {
    const { rows, useHourly: hourly } = await loadSamplesForRange(state.range);
    await loadTransferChartFromRows(rows, hourly);
    const from8h = rangeStart("8h");
    const filter = `recorded_at >= "${toPbFilterDate(from8h)}"`;
    const speedRows = await listAll("transfer_samples", { filter, sort: "recorded_at" });
    await loadSpeedChart8hFromRows(speedRows);
    await loadFolderDiskCharts().catch((err) => console.error("folder disk charts", err));
    return;
  }

  const fromTransfer = rangeStart(state.range);
  const from8h = rangeStart("8h");
  const earliest =
    fromTransfer.getTime() > 0 && fromTransfer.getTime() < from8h.getTime() ? fromTransfer : from8h;
  const filter =
    earliest.getTime() > 0 ? `recorded_at >= "${toPbFilterDate(earliest)}"` : "";
  const rows = await listAll("transfer_samples", { filter, sort: "recorded_at" });
  await Promise.all([
    loadTransferChartFromRows(rows, false),
    loadSpeedChart8hFromRows(rows),
    loadFolderDiskCharts().catch((err) => console.error("folder disk charts", err)),
  ]);
}

async function refresh() {
  setFooterStatus("Instances laden…");
  try {
    state.instances = await listAll("instances", { sort: "name" });
    syncInstanceSelect();
    updateOverviewWhileTopologyLoading();

    const chartsPromise = loadCharts().catch((err) => {
      console.error("charts", err);
      setFooterStatus(`Grafieken: ${err.message}`);
    });

    setFooterStatus("Topologie laden…");
    const topology = await loadTopology();
    renderOverview(topology);
    setFooterStatus(
      `Bijgewerkt ${new Date().toLocaleString()} · collector: long-poll events + ${document.body.dataset.sampleInterval || "60"}s samples`
    );
    await chartsPromise;
  } catch (err) {
    setFooterStatus(err.message);
    console.error(err);
  }
}

refresh();
setInterval(refresh, 60_000);

window.addEventListener("resize", () => {
  if (state.instances.length && state.nodeLayout) {
    requestAnimationFrame(() => {
      renderTopologyEdges(state.topology.links || [], state.nodeLayout);
    });
  }
});
