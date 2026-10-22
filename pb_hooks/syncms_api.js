// Shared Sync-MS API logic (loaded via require() inside route handlers — PB JSVM isolates handler scope).

function readJson(c) {
  const raw = readerToString(c.request.body);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (_) {
    return {};
  }
}

function normalizeBaseUrl(url) {
  return String(url || "")
    .trim()
    .replace(/\/+$/, "");
}

function normalizeDeviceId(id) {
  return String(id || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function stRequest(baseUrl, apiKey, path) {
  return stApi(baseUrl, apiKey, "GET", path);
}

function stApi(baseUrl, apiKey, method, path, bodyObj) {
  const opts = {
    url: `${baseUrl}${path}`,
    method: method,
    headers: { "X-API-Key": apiKey },
    timeout: 20,
  };
  if (bodyObj !== undefined && bodyObj !== null) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(bodyObj);
  }
  return $http.send(opts);
}

function stBrowse(baseUrl, apiKey, current) {
  let path = "/rest/system/browse";
  if (current !== undefined && current !== null && String(current).length > 0) {
    path += "?current=" + encodeURIComponent(String(current));
  }
  return stRequest(baseUrl, apiKey, path);
}

function loadInstanceCredentials(instanceId) {
  if (!instanceId) return { error: "instanceId ontbreekt" };
  let rec;
  try {
    rec = $app.findRecordById("instances", instanceId);
  } catch (_) {
    return { error: "Instance niet gevonden" };
  }
  const baseUrl = normalizeBaseUrl(rec.get("base_url"));
  const apiKey = String(rec.get("api_key") || "").trim();
  if (!baseUrl || !apiKey) {
    return { error: "base_url of api_key ontbreekt op instance" };
  }
  return {
    rec: rec,
    instanceId: instanceId,
    name: rec.get("name") || instanceId,
    baseUrl: baseUrl,
    apiKey: apiKey,
  };
}

function mapConfigFolders(baseUrl, apiKey) {
  const devRes = stRequest(baseUrl, apiKey, "/rest/config/devices");
  let deviceNames = {};
  if (devRes.statusCode === 200) {
    deviceNames = parseDeviceNames(devRes.raw);
  }

  const folderRes = stRequest(baseUrl, apiKey, "/rest/config/folders");
  if (folderRes.statusCode !== 200) {
    return {
      ok: false,
      error: `folders: HTTP ${folderRes.statusCode}`,
      folders: [],
    };
  }

  const folders = parseFolders(folderRes.raw);
  const mapped = [];
  for (let i = 0; i < folders.length; i++) {
    const folder = folders[i];
    const deviceIds = folderDeviceIds(folder);
    const sharedWith = [];
    for (let d = 0; d < deviceIds.length; d++) {
      const devNorm = deviceIds[d];
      sharedWith.push({
        deviceId: devNorm,
        deviceName: deviceNames[devNorm] || devNorm.slice(0, 11) + "…",
      });
    }
    mapped.push({
      id: folder.id || "",
      label: folder.label || folder.id || "map",
      path: folder.path || "",
      type: folder.type || "sendreceive",
      typeLabel: folderTypeLabel(folder.type || "sendreceive"),
      rescanIntervalS: folder.rescanIntervalS || 0,
      sharedWith: sharedWith,
    });
  }

  return { ok: true, error: "", folders: mapped };
}

function canSendFolder(type) {
  return type === "sendreceive" || type === "sendonly";
}

function canReceiveFolder(type) {
  return type === "sendreceive" || type === "receiveonly";
}

function parseFolders(raw) {
  try {
    const data = JSON.parse(raw || "[]");
    return Array.isArray(data) ? data : [];
  } catch (_) {
    return [];
  }
}

function folderDeviceIds(folder) {
  const ids = [];
  const devices = folder.devices || [];
  for (let i = 0; i < devices.length; i++) {
    const d = devices[i];
    const id = d.deviceID || d.deviceId;
    if (id) ids.push(normalizeDeviceId(id));
  }
  return ids;
}

function parseDeviceNames(raw) {
  const map = {};
  try {
    const list = JSON.parse(raw || "[]");
    if (!Array.isArray(list)) return map;
    for (let i = 0; i < list.length; i++) {
      const d = list[i];
      const id = d.deviceID || d.deviceId;
      if (!id) continue;
      map[normalizeDeviceId(id)] = d.name || id;
    }
  } catch (_) {}
  return map;
}

function folderTypeLabel(type) {
  if (type === "sendonly") return "Alleen verzenden";
  if (type === "receiveonly") return "Alleen ontvangen";
  return "Verzenden en ontvangen";
}

function parseDbStatus(raw) {
  try {
    return JSON.parse(raw || "{}");
  } catch (_) {
    return {};
  }
}

function roundCompletionPercent(completion) {
  const n = Number(completion);
  if (!Number.isFinite(n)) return null;
  return Math.min(100, Math.max(0, Math.round(n)));
}

/** Local sync summary via /rest/db/completion + per-folder /rest/db/status (Syncthing REST). */
function summarizeInstanceSync(baseUrl, apiKey, folderIds) {
  const summary = {
    syncStatus: "standby",
    syncLabel: "Standby",
    progressPercent: null,
  };

  if (!folderIds || !folderIds.length) {
    return summary;
  }

  let completionPct = null;
  let needBytes = 0;
  const compRes = stRequest(baseUrl, apiKey, "/rest/db/completion");
  if (compRes.statusCode === 200) {
    const comp = parseDbStatus(compRes.raw);
    completionPct = roundCompletionPercent(comp.completion);
    needBytes = Number(comp.needBytes) || 0;
  }

  let syncing = false;
  let scanning = false;
  for (let i = 0; i < folderIds.length; i++) {
    const folderId = folderIds[i];
    if (!folderId) continue;
    const enc = encodeURIComponent(folderId);
    const stRes = stRequest(baseUrl, apiKey, "/rest/db/status?folder=" + enc);
    if (stRes.statusCode !== 200) continue;
    const db = parseDbStatus(stRes.raw);
    const state = String(db.state || "idle").toLowerCase();
    if (state === "syncing" || state === "sync-preparing") syncing = true;
    else if (state === "scanning" || state === "cleaning") scanning = true;
    const folderNeed = Number(db.needBytes) || 0;
    if (folderNeed > needBytes) needBytes = folderNeed;
  }

  if (syncing) {
    summary.syncStatus = "syncing";
    summary.progressPercent = completionPct;
    summary.syncLabel =
      completionPct != null ? "Syncen " + completionPct + "%" : "Syncen";
    return summary;
  }

  if (scanning) {
    summary.syncStatus = "scanning";
    summary.syncLabel = "Scannen";
    return summary;
  }

  if (needBytes === 0) {
    summary.syncStatus = "uptodate";
    summary.syncLabel = "Bijgewerkt";
    summary.progressPercent = completionPct != null ? completionPct : 100;
    return summary;
  }

  summary.syncStatus = "standby";
  summary.syncLabel = "Standby";
  summary.progressPercent = completionPct;
  return summary;
}

function enrichFolderSharedWith(folder, deviceNames, byDevice) {
  const sharedWith = [];
  const devices = folder.devices || [];
  for (let i = 0; i < devices.length; i++) {
    const devNorm = devices[i];
    const peer = byDevice[devNorm];
    sharedWith.push({
      deviceId: devNorm,
      deviceName: deviceNames[devNorm] || devNorm.slice(0, 11) + "…",
      inSyncMs: !!peer,
      instanceId: peer ? peer.instanceId : "",
      instanceName: peer ? peer.name : "",
    });
  }
  folder.sharedWith = sharedWith;
}

function testConnection(c) {
  const body = readJson(c);
  const baseUrl = normalizeBaseUrl(body.base_url);
  const apiKey = String(body.api_key || "").trim();

  if (!baseUrl || !apiKey) {
    return c.json(400, { ok: false, error: "base_url en api_key zijn verplicht" });
  }

  let versionRes;
  try {
    versionRes = stRequest(baseUrl, apiKey, "/rest/system/version");
  } catch (err) {
    return c.json(200, { ok: false, error: String(err) });
  }

  if (versionRes.statusCode !== 200) {
    const snippet = (versionRes.raw || "").slice(0, 200);
    return c.json(200, {
      ok: false,
      error: `Syncthing /rest/system/version: HTTP ${versionRes.statusCode}${snippet ? ` — ${snippet}` : ""}`,
    });
  }

  let version = "";
  try {
    version = JSON.parse(versionRes.raw || "{}").version || "";
  } catch (_) {
    version = "";
  }

  let deviceId = "";
  try {
    const statusRes = stRequest(baseUrl, apiKey, "/rest/system/status");
    if (statusRes.statusCode === 200) {
      deviceId = JSON.parse(statusRes.raw || "{}").myID || "";
    }
  } catch (_) {
    deviceId = "";
  }

  return c.json(200, {
    ok: true,
    version: version || "unknown",
    deviceId,
  });
}

function listAllInstances() {
  try {
    const all = $app.findAllRecords("instances");
    if (all && all.length >= 0) return all;
  } catch (_) {}

  try {
    return $app.findRecordsByFilter("instances", "", "name", 0, 0) || [];
  } catch (_) {
    return [];
  }
}

function parseConnectedPeers(raw, selfNorm) {
  const peers = [];
  try {
    const data = JSON.parse(raw || "{}");
    const conns = data.connections || {};
    const keys = Object.keys(conns);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const norm = normalizeDeviceId(key);
      if (!norm || norm === selfNorm) continue;
      if (conns[key] && conns[key].connected) peers.push(norm);
    }
  } catch (_) {}
  return peers;
}

function folderListsPeer(folder, peerSyncthingIdNorm) {
  const devices = folder.devices || [];
  return devices.indexOf(peerSyncthingIdNorm) >= 0;
}

/** True when at least one side lists the other in folder.devices (Syncthing share config). */
function folderShareConfigured(fA, fB, syncthingIdA, syncthingIdB) {
  return folderListsPeer(fA, syncthingIdB) || folderListsPeer(fB, syncthingIdA);
}

function resolveFolderDirections(fA, fB, syncthingIdA, syncthingIdB) {
  const typeA = fA.type || "sendreceive";
  const typeB = fB.type || "sendreceive";
  const aListsB = folderListsPeer(fA, syncthingIdB);
  const bListsA = folderListsPeer(fB, syncthingIdA);

  let aToB = false;
  let bToA = false;

  // A → B: folder on A must list B in devices (same data as Syncthing GUI "Gedeeld met").
  if (aListsB) {
    if (typeA === "receiveonly") {
      if (canSendFolder(typeB) && canReceiveFolder(typeA)) bToA = true;
    } else if (typeA === "sendonly") {
      if (canSendFolder(typeA) && canReceiveFolder(typeB)) aToB = true;
    } else if (canSendFolder(typeA) && canReceiveFolder(typeB)) {
      aToB = true;
    }
  }

  if (bListsA) {
    if (typeB === "receiveonly") {
      if (canSendFolder(typeA) && canReceiveFolder(typeB)) aToB = true;
    } else if (typeB === "sendonly") {
      if (canSendFolder(typeB) && canReceiveFolder(typeA)) bToA = true;
    } else if (canSendFolder(typeB) && canReceiveFolder(typeA)) {
      bToA = true;
    }
  }

  return { aToB, bToA };
}

function buildTopologyResponse(c) {
  const records = listAllInstances();
  const managed = [];
  const byDevice = {};

  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    if (rec.get("enabled") === false) continue;

    const instanceId = rec.id;
    const name = rec.get("name") || instanceId;
    const baseUrl = normalizeBaseUrl(rec.get("base_url"));
    const apiKey = String(rec.get("api_key") || "").trim();
    let syncthingId = normalizeDeviceId(rec.get("syncthing_id"));

    const entry = {
      instanceId,
      name,
      syncthingId: "",
      folders: [],
      connectedPeers: [],
      deviceNames: {},
      error: "",
    };

    if (!baseUrl || !apiKey) {
      entry.error = "base_url of api_key ontbreekt";
      managed.push(entry);
      continue;
    }

    try {
      const statusRes = stRequest(baseUrl, apiKey, "/rest/system/status");
      if (statusRes.statusCode === 200) {
        const st = JSON.parse(statusRes.raw || "{}");
        if (st.myID) syncthingId = normalizeDeviceId(st.myID);
      }

      const devRes = stRequest(baseUrl, apiKey, "/rest/config/devices");
      if (devRes.statusCode === 200) {
        entry.deviceNames = parseDeviceNames(devRes.raw);
      }

      const folderRes = stRequest(baseUrl, apiKey, "/rest/config/folders");
      if (folderRes.statusCode !== 200) {
        const prev = entry.error ? entry.error + "; " : "";
        entry.error = prev + `folders: HTTP ${folderRes.statusCode}`;
      } else {
        const folders = parseFolders(folderRes.raw);
        for (let f = 0; f < folders.length; f++) {
          const folder = folders[f];
          entry.folders.push({
            id: folder.id || "",
            label: folder.label || folder.id || "map",
            path: folder.path || "",
            type: folder.type || "sendreceive",
            typeLabel: folderTypeLabel(folder.type || "sendreceive"),
            rescanIntervalS: folder.rescanIntervalS || 0,
            devices: folderDeviceIds(folder),
            sharedWith: [],
          });
        }
      }

      if (syncthingId) {
        const connRes = stRequest(baseUrl, apiKey, "/rest/system/connections");
        if (connRes.statusCode === 200) {
          entry.connectedPeers = parseConnectedPeers(connRes.raw, syncthingId);
        }
      }

      const folderIds = [];
      for (let fi = 0; fi < entry.folders.length; fi++) {
        if (entry.folders[fi].id) folderIds.push(entry.folders[fi].id);
      }
      const sync = summarizeInstanceSync(baseUrl, apiKey, folderIds);
      entry.syncStatus = sync.syncStatus;
      entry.syncLabel = sync.syncLabel;
      entry.progressPercent = sync.progressPercent;
    } catch (err) {
      entry.error = String(err);
    }

    if (!entry.syncStatus) {
      entry.syncStatus = "unknown";
      entry.syncLabel = "—";
      entry.progressPercent = null;
    }

    entry.syncthingId = syncthingId;
    managed.push(entry);

    if (syncthingId) {
      const folderMap = {};
      for (let j = 0; j < entry.folders.length; j++) {
        const fo = entry.folders[j];
        if (fo.id) folderMap[fo.id] = fo;
      }
      byDevice[syncthingId] = { instanceId, name, folders: folderMap };
    }
  }

  for (let i = 0; i < managed.length; i++) {
    const entry = managed[i];
    for (let j = 0; j < entry.folders.length; j++) {
      enrichFolderSharedWith(entry.folders[j], entry.deviceNames, byDevice);
    }
  }

  const links = [];
  const linkKeys = {};

  function pushFolderLink(instA, instB, fA, fB) {
    const pairKey =
      instA.instanceId < instB.instanceId
        ? `${instA.instanceId}|${instB.instanceId}|${fA.id}`
        : `${instB.instanceId}|${instA.instanceId}|${fA.id}`;
    if (linkKeys[pairKey]) return;

    const dir = resolveFolderDirections(fA, fB, instA.syncthingId, instB.syncthingId);
    const aToB = dir.aToB;
    const bToA = dir.bToA;
    if (!aToB && !bToA) return;

    linkKeys[pairKey] = true;
    links.push({
      kind: "folder",
      folderId: fA.id,
      folderLabel: fA.label || fB.label || fA.id,
      from: instA.instanceId,
      to: instB.instanceId,
      aToB,
      bToA,
      bidirectional: aToB && bToA,
    });
  }

  for (let a = 0; a < managed.length; a++) {
    for (let b = a + 1; b < managed.length; b++) {
      const instA = managed[a];
      const instB = managed[b];
      if (!instA.syncthingId || !instB.syncthingId) continue;

      const foldersB = {};
      for (let fi = 0; fi < instB.folders.length; fi++) {
        const fb = instB.folders[fi];
        if (fb.id) foldersB[fb.id] = fb;
      }

      for (let fi = 0; fi < instA.folders.length; fi++) {
        const fA = instA.folders[fi];
        if (!fA.id) continue;
        const fB = foldersB[fA.id];
        if (!fB) continue;
        if (!folderShareConfigured(fA, fB, instA.syncthingId, instB.syncthingId)) continue;
        pushFolderLink(instA, instB, fA, fB);
      }
    }
  }

  const pairHasFolder = {};
  for (let li = 0; li < links.length; li++) {
    const l = links[li];
    const pk = l.from < l.to ? `${l.from}|${l.to}` : `${l.to}|${l.from}`;
    pairHasFolder[pk] = true;
  }

  for (let a = 0; a < managed.length; a++) {
    const instA = managed[a];
    if (!instA.syncthingId) continue;
    for (let pi = 0; pi < instA.connectedPeers.length; pi++) {
      const peerDev = instA.connectedPeers[pi];
      const peer = byDevice[peerDev];
      if (!peer || peer.instanceId === instA.instanceId) continue;

      const pk =
        instA.instanceId < peer.instanceId
          ? `${instA.instanceId}|${peer.instanceId}`
          : `${peer.instanceId}|${instA.instanceId}`;
      if (pairHasFolder[pk]) continue;

      const connKey = `${pk}|__connection__`;
      if (linkKeys[connKey]) continue;
      linkKeys[connKey] = true;

      links.push({
        kind: "connection",
        folderId: "",
        folderLabel: "Live verbinding",
        from: instA.instanceId,
        to: peer.instanceId,
        aToB: true,
        bToA: true,
        bidirectional: true,
      });
      pairHasFolder[pk] = true;
    }
  }

  const hints = [];
  if (managed.length < 2) {
    hints.push("Voeg minimaal 2 enabled instances toe in Sync-MS om pijlen tussen nodes te tonen.");
  }
  let withId = 0;
  for (let i = 0; i < managed.length; i++) {
    if (managed[i].syncthingId) withId++;
  }
  if (managed.length >= 2 && withId < 2) {
    hints.push(
      "syncthing_id ontbreekt op een of meer nodes — wacht op collector of gebruik Verbinding testen."
    );
  }
  let folderLinks = 0;
  for (let i = 0; i < links.length; i++) {
    if (links[i].kind === "folder") folderLinks++;
  }
  if (managed.length >= 2 && withId >= 2 && folderLinks === 0) {
    hints.push(
      "Geen gemeenschappelijke folder-ID's tussen geregistreerde instances — beide nodes moeten in Sync-MS staan (Pixel/Laptop/etc. alleen in Syncthing is niet genoeg voor een pijl)."
    );
  }
  for (let i = 0; i < managed.length; i++) {
    if (managed[i].error && managed[i].error.indexOf("folders:") >= 0) {
      hints.push(
        "API key heeft mogelijk geen rechten voor /rest/config/folders — maak een key met config-lezen aan."
      );
      break;
    }
  }

  const pairDebug = [];
  for (let a = 0; a < managed.length; a++) {
    for (let b = a + 1; b < managed.length; b++) {
      const instA = managed[a];
      const instB = managed[b];
      const common = [];
      const foldersByIdB = {};
      for (let i = 0; i < instB.folders.length; i++) {
        const fb = instB.folders[i];
        if (fb.id) foldersByIdB[fb.id] = fb;
      }
      for (let i = 0; i < instA.folders.length; i++) {
        const fA = instA.folders[i];
        const id = fA.id;
        if (!id || !foldersByIdB[id]) continue;
        const fB = foldersByIdB[id];
        if (!folderShareConfigured(fA, fB, instA.syncthingId, instB.syncthingId)) continue;
        common.push(id);
      }
      if (common.length) {
        pairDebug.push({
          a: instA.name,
          b: instB.name,
          commonFolderIds: common,
        });
      }
    }
  }

  return c.json(200, {
    instances: managed.map((m) => ({
      instanceId: m.instanceId,
      name: m.name,
      syncthingId: m.syncthingId,
      folderCount: m.folders.length,
      connectedPeerCount: m.connectedPeers.length,
      error: m.error,
      syncStatus: m.syncStatus || "unknown",
      syncLabel: m.syncLabel || "—",
      progressPercent: m.progressPercent,
      folders: m.folders.map((f) => ({
        id: f.id,
        label: f.label,
        path: f.path,
        type: f.type,
        typeLabel: f.typeLabel,
        rescanIntervalS: f.rescanIntervalS,
        sharedWith: f.sharedWith || [],
      })),
    })),
    links,
    diagnostics: {
      managedCount: managed.length,
      withSyncthingId: withId,
      folderLinkCount: folderLinks,
      connectionLinkCount: links.length - folderLinks,
      hints,
      pairDebug,
    },
  });
}

function backupConfig(c) {
  const records = listAllInstances();
  const instances = [];
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    instances.push({
      name: String(rec.get("name") || "").trim(),
      base_url: String(rec.get("base_url") || "").trim(),
      api_key: String(rec.get("api_key") || "").trim(),
      enabled: rec.get("enabled") !== false,
    });
  }
  return c.json(200, {
    syncms_backup_version: 1,
    exported_at: new Date().toISOString(),
    instances,
  });
}

function restoreConfig(c) {
  const body = readJson(c);
  if (body.syncms_backup_version !== 1 || !Array.isArray(body.instances)) {
    return c.json(400, {
      ok: false,
      error: "Ongeldig backup-bestand (syncms_backup_version: 1 en instances[] vereist).",
    });
  }

  const existing = listAllInstances();
  const byName = {};
  for (let i = 0; i < existing.length; i++) {
    const rec = existing[i];
    const n = String(rec.get("name") || "")
      .trim()
      .toLowerCase();
    if (n) byName[n] = rec;
  }

  let created = 0;
  let updated = 0;
  let skipped = 0;
  const collection = $app.findCollectionByNameOrId("instances");

  for (let j = 0; j < body.instances.length; j++) {
    const item = body.instances[j] || {};
    const name = String(item.name || "").trim();
    const baseUrl = normalizeBaseUrl(item.base_url);
    const apiKey = String(item.api_key || "").trim();
    const enabled = item.enabled !== false;

    if (!name || !baseUrl || !apiKey) {
      skipped++;
      continue;
    }

    const key = name.toLowerCase();
    const prev = byName[key];
    if (prev) {
      prev.set("base_url", baseUrl);
      prev.set("api_key", apiKey);
      prev.set("enabled", enabled);
      $app.save(prev);
      updated++;
    } else {
      const rec = new Record(collection);
      rec.set("name", name);
      rec.set("base_url", baseUrl);
      rec.set("api_key", apiKey);
      rec.set("enabled", enabled);
      rec.set("last_event_id", 0);
      rec.set("online", false);
      rec.set("sample_count", 0);
      rec.set("in_bytes_alltime", 0);
      rec.set("out_bytes_alltime", 0);
      $app.save(rec);
      byName[key] = rec;
      created++;
    }
  }

  return c.json(200, {
    ok: true,
    created,
    updated,
    skipped,
    total: body.instances.length,
  });
}

function resolveSyncthingDeviceId(cred) {
  let id = String(cred.rec.get("syncthing_id") || "").trim();
  if (id) return id;
  try {
    const st = stRequest(cred.baseUrl, cred.apiKey, "/rest/system/status");
    if (st.statusCode === 200) {
      id = JSON.parse(st.raw || "{}").myID || "";
    }
  } catch (_) {}
  return id;
}

function sanitizeFolderId(raw) {
  return String(raw || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function mergeFolderDevices(existingDevices, remoteDeviceIds) {
  const list = [];
  const seen = {};
  const src = existingDevices || [];
  for (let i = 0; i < src.length; i++) {
    const d = src[i];
    const id = d.deviceID || d.deviceId;
    if (!id) continue;
    const norm = normalizeDeviceId(id);
    if (seen[norm]) continue;
    seen[norm] = true;
    list.push({ deviceID: id });
  }
  for (let j = 0; j < remoteDeviceIds.length; j++) {
    const id = remoteDeviceIds[j];
    if (!id) continue;
    const norm = normalizeDeviceId(id);
    if (seen[norm]) continue;
    seen[norm] = true;
    list.push({ deviceID: id });
  }
  return list;
}

function ensureRemoteDevice(baseUrl, apiKey, remoteDeviceId, remoteName) {
  const enc = encodeURIComponent(remoteDeviceId);
  const existing = stRequest(baseUrl, apiKey, "/rest/config/devices/" + enc);
  if (existing.statusCode === 200) return { ok: true };

  const defRes = stRequest(baseUrl, apiKey, "/rest/config/defaults/device");
  if (defRes.statusCode !== 200) {
    return { ok: false, error: "defaults/device HTTP " + defRes.statusCode };
  }
  let dev;
  try {
    dev = JSON.parse(defRes.raw || "{}");
  } catch (_) {
    return { ok: false, error: "defaults/device parse" };
  }
  dev.deviceID = remoteDeviceId;
  dev.name = remoteName || remoteDeviceId.slice(0, 11);

  const post = stApi(baseUrl, apiKey, "POST", "/rest/config/devices", dev);
  if (post.statusCode >= 200 && post.statusCode < 300) return { ok: true };
  const snippet = (post.raw || "").slice(0, 200);
  return { ok: false, error: "device POST HTTP " + post.statusCode + snippet };
}

function upsertFolderShare(baseUrl, apiKey, folderId, label, folderPath, remoteDeviceIds) {
  const enc = encodeURIComponent(folderId);
  let folder = null;
  let existed = false;

  const getRes = stRequest(baseUrl, apiKey, "/rest/config/folders/" + enc);
  if (getRes.statusCode === 200) {
    existed = true;
    try {
      folder = JSON.parse(getRes.raw || "{}");
    } catch (_) {
      folder = null;
    }
  }

  if (!folder) {
    const defRes = stRequest(baseUrl, apiKey, "/rest/config/defaults/folder");
    if (defRes.statusCode !== 200) {
      return { ok: false, error: "defaults/folder HTTP " + defRes.statusCode };
    }
    try {
      folder = JSON.parse(defRes.raw || "{}");
    } catch (_) {
      return { ok: false, error: "defaults/folder parse" };
    }
    folder.id = folderId;
  }

  folder.label = label || folder.label || folderId;
  folder.path = folderPath;
  folder.type = folder.type || "sendreceive";
  folder.devices = mergeFolderDevices(folder.devices, remoteDeviceIds);

  const res = stApi(baseUrl, apiKey, "POST", "/rest/config/folders", folder);
  if (res.statusCode >= 200 && res.statusCode < 300) {
    return { ok: true, existed: existed };
  }
  const snippet = (res.raw || "").slice(0, 240);
  return { ok: false, error: "folder POST HTTP " + res.statusCode + (snippet ? " — " + snippet : "") };
}

function remoteDeviceConfigured(baseUrl, apiKey, remoteDeviceId) {
  if (!remoteDeviceId) return false;
  const enc = encodeURIComponent(remoteDeviceId);
  const existing = stRequest(baseUrl, apiKey, "/rest/config/devices/" + enc);
  return existing.statusCode === 200;
}

/** Add or update a folder on one Syncthing instance (does not share with remote devices). */
function applyAddFolder(c) {
  const instanceId = c.request.pathValue("instanceId");
  const body = readJson(c);
  const folderId = sanitizeFolderId(body.folder_id || body.folderId);
  const label = String(body.label || folderId || "").trim();
  const folderPath = String(body.source_path || body.sourcePath || body.path || "").trim();

  if (!folderId) {
    return c.json(400, { ok: false, error: "folder_id is verplicht" });
  }
  if (!folderPath) {
    return c.json(400, { ok: false, error: "source_path is verplicht (kies map in browser)" });
  }

  const cred = loadInstanceCredentials(instanceId);
  if (cred.error) {
    return c.json(400, { ok: false, error: cred.error });
  }

  const onInst = upsertFolderShare(cred.baseUrl, cred.apiKey, folderId, label, folderPath, []);
  if (!onInst.ok) {
    return c.json(200, { ok: false, error: onInst.error, instance: cred.name });
  }

  return c.json(200, {
    ok: true,
    folderId: folderId,
    label: label,
    path: folderPath,
    existed: onInst.existed,
    instance: cred.name,
  });
}

/** Backward-compatible alias: same as add-folder (partners in body are ignored). */
function applyFolderShare(c) {
  return applyAddFolder(c);
}

function loadSyncthingNode(instanceId) {
  let rec;
  try {
    rec = $app.findRecordById("instances", instanceId);
  } catch (_) {
    return { error: "Instance niet gevonden: " + instanceId };
  }
  if (rec.get("enabled") === false) {
    return { error: "Instance uitgeschakeld: " + (rec.get("name") || instanceId) };
  }
  const cred = loadInstanceCredentials(instanceId);
  if (cred.error) return { error: cred.error };
  const deviceId = resolveSyncthingDeviceId(cred);
  if (!deviceId) {
    return { error: "syncthing_id onbekend op instance: " + cred.name };
  }
  return { cred: cred, deviceId: deviceId };
}

function linkTwoSyncthingNodes(na, nb, steps) {
  const aHasB = remoteDeviceConfigured(na.cred.baseUrl, na.cred.apiKey, nb.deviceId);
  const bHasA = remoteDeviceConfigured(nb.cred.baseUrl, nb.cred.apiKey, na.deviceId);

  if (aHasB && bHasA) {
    steps.push({
      from: na.cred.name,
      to: nb.cred.name,
      action: "already_linked",
      ok: true,
    });
    return { ok: true, linked: false, alreadyLinked: true };
  }

  if (!aHasB) {
    const r = ensureRemoteDevice(na.cred.baseUrl, na.cred.apiKey, nb.deviceId, nb.cred.name);
    steps.push({
      instance: na.cred.name,
      remote: nb.cred.name,
      direction: "add_device",
      ok: r.ok,
      error: r.error || "",
    });
    if (!r.ok) {
      return { ok: false, error: na.cred.name + " → " + nb.cred.name + ": " + r.error };
    }
  }

  if (!bHasA) {
    const r = ensureRemoteDevice(nb.cred.baseUrl, nb.cred.apiKey, na.deviceId, na.cred.name);
    steps.push({
      instance: nb.cred.name,
      remote: na.cred.name,
      direction: "add_device",
      ok: r.ok,
      error: r.error || "",
    });
    if (!r.ok) {
      return { ok: false, error: nb.cred.name + " → " + na.cred.name + ": " + r.error };
    }
  }

  steps.push({
    from: na.cred.name,
    to: nb.cred.name,
    action: "linked",
    ok: true,
  });
  return { ok: true, linked: true, alreadyLinked: false };
}

function autoPairDevices(c) {
  const body = readJson(c);
  const sourceId = String(body.source_instance_id || body.sourceInstanceId || "").trim();
  const partnerIdsRaw = body.partner_instance_ids || body.partnerInstanceIds;

  const steps = [];
  let pairsLinked = 0;
  let pairsAlreadyLinked = 0;

  if (sourceId && Array.isArray(partnerIdsRaw) && partnerIdsRaw.length > 0) {
    const sourceNode = loadSyncthingNode(sourceId);
    if (sourceNode.error) {
      return c.json(400, { ok: false, error: sourceNode.error });
    }

    for (let i = 0; i < partnerIdsRaw.length; i++) {
      const pid = String(partnerIdsRaw[i] || "").trim();
      if (!pid || pid === sourceId) continue;
      const partnerNode = loadSyncthingNode(pid);
      if (partnerNode.error) {
        return c.json(400, { ok: false, error: partnerNode.error });
      }
      const result = linkTwoSyncthingNodes(sourceNode, partnerNode, steps);
      if (!result.ok) {
        return c.json(200, { ok: false, error: result.error, steps: steps });
      }
      if (result.alreadyLinked) pairsAlreadyLinked++;
      else if (result.linked) pairsLinked++;
    }

    return c.json(200, {
      ok: true,
      mode: "selected",
      sourceInstanceId: sourceId,
      sourceName: sourceNode.cred.name,
      partnerCount: partnerIdsRaw.length,
      pairsLinked: pairsLinked,
      pairsAlreadyLinked: pairsAlreadyLinked,
      steps: steps,
    });
  }

  const records = listAllInstances();
  const nodes = [];

  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    if (rec.get("enabled") === false) continue;
    const node = loadSyncthingNode(rec.id);
    if (node.error) {
      return c.json(400, { ok: false, error: node.error });
    }
    nodes.push(node);
  }

  for (let a = 0; a < nodes.length; a++) {
    for (let b = a + 1; b < nodes.length; b++) {
      const result = linkTwoSyncthingNodes(nodes[a], nodes[b], steps);
      if (!result.ok) {
        return c.json(200, { ok: false, error: result.error, steps: steps });
      }
      if (result.alreadyLinked) pairsAlreadyLinked++;
      else if (result.linked) pairsLinked++;
    }
  }

  return c.json(200, {
    ok: true,
    mode: "all",
    instanceCount: nodes.length,
    pairsLinked: pairsLinked,
    pairsAlreadyLinked: pairsAlreadyLinked,
    steps: steps,
  });
}

function instanceBrowse(c) {
  const instanceId = c.request.pathValue("instanceId");
  const cred = loadInstanceCredentials(instanceId);
  if (cred.error) {
    return c.json(400, { ok: false, error: cred.error, entries: [] });
  }

  const current = c.request.url.query().get("current") || "";

  try {
    const res = stBrowse(cred.baseUrl, cred.apiKey, current);
    if (res.statusCode !== 200) {
      const snippet = (res.raw || "").slice(0, 200);
      return c.json(200, {
        ok: false,
        error: `browse: HTTP ${res.statusCode}${snippet ? " — " + snippet : ""}`,
        instanceId: cred.instanceId,
        instanceName: cred.name,
        current: current,
        entries: [],
        readOnly: true,
      });
    }

    let entries = [];
    try {
      entries = JSON.parse(res.raw || "[]");
      if (!Array.isArray(entries)) entries = [];
    } catch (_) {
      entries = [];
    }

    return c.json(200, {
      ok: true,
      instanceId: cred.instanceId,
      instanceName: cred.name,
      current: current,
      entries: entries,
      readOnly: true,
      hint: "Browse read-only; gebruik hieronder om een map aan Syncthing toe te voegen.",
    });
  } catch (err) {
    return c.json(200, {
      ok: false,
      error: String(err),
      instanceId: cred.instanceId,
      instanceName: cred.name,
      current: current,
      entries: [],
      readOnly: true,
    });
  }
}

function findInstanceRecordForDiskReport(body) {
  const instanceId = String(body.instance_id || "").trim();
  if (instanceId) {
    try {
      return $app.findRecordById("instances", instanceId);
    } catch (_) {
      return null;
    }
  }
  const deviceRaw = String(body.device_id || body.syncthing_id || body.my_id || "").trim();
  if (!deviceRaw) return null;
  const norm = normalizeDeviceId(deviceRaw);
  const all = listAllInstances();
  for (let i = 0; i < all.length; i++) {
    const rec = all[i];
    const sid = normalizeDeviceId(String(rec.get("syncthing_id") || ""));
    if (sid && sid === norm) return rec;
  }
  for (let j = 0; j < all.length; j++) {
    const rec = all[j];
    if (rec.get("enabled") === false) continue;
    const baseUrl = normalizeBaseUrl(rec.get("base_url"));
    const apiKey = String(rec.get("api_key") || "").trim();
    if (!baseUrl || !apiKey) continue;
    const st = stRequest(baseUrl, apiKey, "/rest/system/status");
    if (st.statusCode !== 200) continue;
    let myID = "";
    try {
      myID = normalizeDeviceId(JSON.parse(st.raw || "{}").myID || "");
    } catch (_) {
      myID = "";
    }
    if (myID !== norm) continue;
    const rawId = String(JSON.parse(st.raw || "{}").myID || "").trim();
    if (rawId && !String(rec.get("syncthing_id") || "").trim()) {
      rec.set("syncthing_id", rawId);
      try {
        $app.save(rec);
      } catch (_) {}
    }
    return rec;
  }
  return null;
}

function saveFolderDiskSamples(instanceId, body, source) {
  const items = Array.isArray(body.folders) ? body.folders : [];
  if (!items.length) {
    return {
      ok: false,
      error: "folders[] vereist (folder_id, free_bytes; optioneel folder_label, total_bytes).",
      created: 0,
      errors: [],
    };
  }

  const collection = $app.findCollectionByNameOrId("folder_disk_samples");
  const recorded =
    body.recorded_at && String(body.recorded_at).trim()
      ? String(body.recorded_at).trim()
      : new Date().toISOString();

  let created = 0;
  const errors = [];
  const src = String(source || "api").slice(0, 32);

  for (let i = 0; i < items.length; i++) {
    const item = items[i] || {};
    const folderId = String(item.folder_id || item.id || "").trim();
    if (!folderId) {
      errors.push("map zonder folder_id overgeslagen");
      continue;
    }
    const freeBytes = Number(item.free_bytes);
    if (!Number.isFinite(freeBytes) || freeBytes < 0) {
      errors.push(`${folderId}: free_bytes ontbreekt of ongeldig`);
      continue;
    }
    const totalRaw = item.total_bytes;
    const totalBytes =
      totalRaw === undefined || totalRaw === null || totalRaw === ""
        ? null
        : Number(totalRaw);
    if (totalBytes !== null && (!Number.isFinite(totalBytes) || totalBytes < 0)) {
      errors.push(`${folderId}: total_bytes ongeldig`);
      continue;
    }

    let label = String(item.folder_label || item.label || "").trim();
    if (!label) label = folderId;

    try {
      const rec = new Record(collection);
      rec.set("instance", instanceId);
      rec.set("folder_id", folderId);
      rec.set("folder_label", label);
      rec.set("recorded_at", recorded);
      rec.set("free_bytes", freeBytes);
      if (totalBytes !== null) rec.set("total_bytes", totalBytes);
      rec.set("source", src);
      $app.save(rec);
      created++;
    } catch (err) {
      errors.push(`${folderId}: ${String(err)}`);
    }
  }

  return {
    ok: created > 0 || errors.length === 0,
    created,
    errors,
  };
}

/** Agent on Syncthing host: POST folders[] + device_id (Syncthing myID) or instance_id. */
function folderDiskReport(c) {
  const body = readJson(c);
  const instRec = findInstanceRecordForDiskReport(body);
  if (!instRec) {
    return c.json(404, {
      ok: false,
      error:
        "Geen instance gevonden. Zet device_id (Syncthing myID) of instance_id in het verzoek; " +
        "syncthing_id moet op de instance staan (collector of Verbinding testen).",
      created: 0,
    });
  }

  const result = saveFolderDiskSamples(instRec.id, body, "agent");
  if (result.error) {
    return c.json(400, {
      ok: false,
      error: result.error,
      instanceId: instRec.id,
      instanceName: instRec.get("name") || instRec.id,
      created: 0,
    });
  }

  return c.json(200, {
    ok: result.ok,
    instanceId: instRec.id,
    instanceName: instRec.get("name") || instRec.id,
    created: result.created,
    errors: result.errors,
  });
}

function pushFolderDisk(c) {
  const instanceId = c.request.pathValue("instanceId");
  const cred = loadInstanceCredentials(instanceId);
  if (cred.error) {
    return c.json(400, { ok: false, error: cred.error, created: 0 });
  }

  const body = readJson(c);
  const result = saveFolderDiskSamples(cred.instanceId, body, "api");
  if (result.error) {
    return c.json(400, {
      ok: false,
      error: result.error,
      instanceId: cred.instanceId,
      instanceName: cred.name,
      created: 0,
    });
  }

  return c.json(200, {
    ok: result.ok,
    instanceId: cred.instanceId,
    instanceName: cred.name,
    created: result.created,
    errors: result.errors,
  });
}

function instanceFolders(c) {
  const instanceId = c.request.pathValue("instanceId");
  const cred = loadInstanceCredentials(instanceId);
  if (cred.error) {
    return c.json(400, { ok: false, error: cred.error, folders: [] });
  }

  try {
    const result = mapConfigFolders(cred.baseUrl, cred.apiKey);
    return c.json(200, {
      ok: result.ok,
      error: result.error,
      instanceId: cred.instanceId,
      instanceName: cred.name,
      folders: result.folders,
      readOnly: true,
    });
  } catch (err) {
    return c.json(200, {
      ok: false,
      error: String(err),
      instanceId: cred.instanceId,
      instanceName: cred.name,
      folders: [],
      readOnly: true,
    });
  }
}

function topology(c) {
  try {
    return buildTopologyResponse(c);
  } catch (err) {
    return c.json(200, {
      instances: [],
      links: [],
      diagnostics: {
        managedCount: 0,
        withSyncthingId: 0,
        folderLinkCount: 0,
        connectionLinkCount: 0,
        hints: ["Topologie-hook fout: " + String(err)],
        pairDebug: [],
        hookError: String(err),
      },
    });
  }
}

module.exports = {
  testConnection,
  topology,
  backupConfig,
  restoreConfig,
  instanceBrowse,
  instanceFolders,
  folderDiskReport,
  pushFolderDisk,
  applyAddFolder,
  applyFolderShare,
  autoPairDevices,
};
