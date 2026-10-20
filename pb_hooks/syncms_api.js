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
  return $http.send({
    url: `${baseUrl}${path}`,
    method: "GET",
    headers: { "X-API-Key": apiKey },
    timeout: 12,
  });
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
    } catch (err) {
      entry.error = String(err);
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
};
