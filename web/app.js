const state = {
  instances: [],
  range: "24h",
  chartInstance: "",
  editingId: null,
  transferChart: null,
  speedChart: null,
};

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
  return `${formatBytes(bps)}/s`;
}

function rangeStart(range) {
  const now = new Date();
  switch (range) {
    case "24h":
      return new Date(now.getTime() - 24 * 3600 * 1000);
    case "7d":
      return new Date(now.getTime() - 7 * 24 * 3600 * 1000);
    case "month":
      return new Date(now.getTime() - 30 * 24 * 3600 * 1000);
    default:
      return new Date(0);
  }
}

function bucketKey(d, range) {
  const t = d.getTime();
  if (range === "24h") {
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

function renderCharts(data) {
  const c = chartColors();
  const transferCtx = document.getElementById("transfer-chart");
  const speedCtx = document.getElementById("speed-chart");

  if (state.transferChart) state.transferChart.destroy();
  if (state.speedChart) state.speedChart.destroy();

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
        },
        {
          label: "Upload snelheid",
          data: data.outSpeed,
          borderColor: c.out,
          backgroundColor: c.outFill,
          fill: true,
          tension: 0.25,
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
            callback: (v) => formatSpeed(v),
          },
          grid: { color: c.grid },
        },
      },
      plugins: {
        legend: { labels: { color: c.text } },
        tooltip: {
          callbacks: {
            label: (ctx) => `${ctx.dataset.label}: ${formatSpeed(ctx.raw)}`,
          },
        },
      },
    },
  });
}

function renderInstanceCards() {
  const root = document.getElementById("instance-cards");
  if (!state.instances.length) {
    root.innerHTML =
      '<p class="hint">Nog geen instances. Voeg je Syncthing-installaties toe (URL + API key).</p>';
    return;
  }
  root.innerHTML = state.instances
    .map((inst) => {
      const online = inst.online;
      return `
      <article class="card" data-id="${inst.id}">
        <div class="card-head">
          <h3>${escapeHtml(inst.name)}</h3>
          <span class="badge ${online ? "ok" : "off"}">${online ? "Online" : "Offline"}</span>
        </div>
        <dl class="stat-grid">
          <dt>Totaal in</dt><dd>${formatBytes(inst.in_bytes_total)}</dd>
          <dt>Totaal out</dt><dd>${formatBytes(inst.out_bytes_total)}</dd>
          <dt>Snelheid in</dt><dd>${formatSpeed(inst.in_speed_bps)}</dd>
          <dt>Snelheid out</dt><dd>${formatSpeed(inst.out_speed_bps)}</dd>
          <dt>Versie</dt><dd>${escapeHtml(inst.version || "—")}</dd>
          <dt>Laatst gezien</dt><dd>${formatWhen(inst.last_seen)}</dd>
        </dl>
        ${
          inst.last_error
            ? `<p class="hint small" style="color:var(--danger)">${escapeHtml(inst.last_error)}</p>`
            : ""
        }
        <div class="card-actions">
          <button type="button" class="btn ghost btn-edit">Bewerken</button>
          <button type="button" class="btn danger btn-delete">Verwijderen</button>
        </div>
      </article>`;
    })
    .join("");

  root.querySelectorAll(".btn-edit").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.closest(".card").dataset.id;
      openDialog(state.instances.find((i) => i.id === id));
    });
  });
  root.querySelectorAll(".btn-delete").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.closest(".card").dataset.id;
      const inst = state.instances.find((i) => i.id === id);
      if (!confirm(`Instance "${inst.name}" verwijderen?`)) return;
      await pbRequest(`/api/collections/instances/records/${id}`, { method: "DELETE" });
      await refresh();
    });
  });
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatWhen(s) {
  const d = parsePbDate(s);
  if (!d) return "—";
  return d.toLocaleString();
}

const dialog = document.getElementById("instance-dialog");
const form = document.getElementById("instance-form");

function openDialog(inst) {
  state.editingId = inst?.id || null;
  document.getElementById("dialog-title").textContent = inst
    ? "Instance bewerken"
    : "Syncthing instance";
  form.name.value = inst?.name || "";
  form.base_url.value = inst?.base_url || "";
  form.api_key.value = inst?.api_key || "";
  form.enabled.checked = inst ? inst.enabled !== false : true;
  dialog.showModal();
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = {
    name: form.name.value.trim(),
    base_url: form.base_url.value.trim(),
    api_key: form.api_key.value.trim(),
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

async function loadCharts() {
  const { rows, useHourly } = await loadSamplesForRange(state.range);
  let filtered = rows;
  if (state.chartInstance) {
    filtered = rows.filter((r) => r.instance === state.chartInstance);
  }
  const data = aggregateChartData(filtered, useHourly, state.range);
  renderCharts(data);
}

async function refresh() {
  const footer = document.getElementById("footer-status");
  footer.textContent = "Laden…";
  try {
    state.instances = await listAll("instances", { sort: "name" });
    syncInstanceSelect();
    renderInstanceCards();
    await loadCharts();
    footer.textContent = `Bijgewerkt ${new Date().toLocaleString()} · collector: long-poll events + ${document.body.dataset.sampleInterval || "60"}s samples`;
  } catch (err) {
    footer.textContent = err.message;
    console.error(err);
  }
}

refresh();
setInterval(refresh, 60_000);
