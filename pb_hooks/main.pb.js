/// <reference path="../pb_data/types.d.ts" />

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
    timeout: 25,
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
    const id = d.deviceID || d.deviceId || d.id;
    if (id) ids.push(normalizeDeviceId(id));
  }
  return ids;
}

routerAdd("POST", "/api/syncms/test-connection", (c) => {
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
});

function listEnabledInstances() {
  const out = [];
  let offset = 0;
  for (;;) {
    const chunk = $app.findRecordsByFilter("instances", "enabled = true", "name", 200, offset);
    if (!chunk || chunk.length === 0) break;
    for (let i = 0; i < chunk.length; i++) out.push(chunk[i]);
    if (chunk.length < 200) break;
    offset += chunk.length;
  }
  return out;
}

routerAdd("GET", "/api/syncms/topology", (c) => {
  const records = listEnabledInstances();
  const managed = [];

  /** @type {Record<string, { instanceId: string, name: string, folders: Map<string, any> }>} */
  const byDevice = {};

  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    if (!rec.get("enabled")) continue;

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

      const folderRes = stRequest(baseUrl, apiKey, "/rest/config/folders");
      if (folderRes.statusCode !== 200) {
        entry.error = `folders: HTTP ${folderRes.statusCode}`;
      } else {
        const folders = parseFolders(folderRes.raw);
        for (let f = 0; f < folders.length; f++) {
          const folder = folders[f];
          entry.folders.push({
            id: folder.id || "",
            label: folder.label || folder.id || "map",
            type: folder.type || "sendreceive",
            devices: folderDeviceIds(folder),
          });
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

  const links = [];
  const linkKeys = {};

  for (let a = 0; a < managed.length; a++) {
    const instA = managed[a];
    if (!instA.syncthingId) continue;

    for (let fi = 0; fi < instA.folders.length; fi++) {
      const fA = instA.folders[fi];
      if (!fA.id) continue;

      for (let di = 0; di < fA.devices.length; di++) {
        const devId = fA.devices[di];
        const peer = byDevice[devId];
        if (!peer || peer.instanceId === instA.instanceId) continue;

        let instB = null;
        for (let mi = 0; mi < managed.length; mi++) {
          if (managed[mi].instanceId === peer.instanceId) {
            instB = managed[mi];
            break;
          }
        }
        if (!instB) continue;

        const pairKey =
          instA.instanceId < peer.instanceId
            ? `${instA.instanceId}|${peer.instanceId}|${fA.id}`
            : `${peer.instanceId}|${instA.instanceId}|${fA.id}`;
        if (linkKeys[pairKey]) continue;

        const fB = peer.folders[fA.id] || null;

        let aToB = canSendFolder(fA.type);
        let bToA = false;

        if (fB) {
          aToB = aToB && canReceiveFolder(fB.type) && fB.devices.indexOf(instA.syncthingId) >= 0;
          bToA =
            canSendFolder(fB.type) &&
            canReceiveFolder(fA.type) &&
            fB.devices.indexOf(instA.syncthingId) >= 0;
        } else if (fA.type === "sendonly") {
          aToB = true;
          bToA = false;
        } else if (fA.type === "receiveonly") {
          aToB = false;
          bToA = true;
        } else if (fA.type === "sendreceive") {
          aToB = true;
          bToA = true;
        }

        if (!aToB && !bToA) continue;

        linkKeys[pairKey] = true;
        links.push({
          folderId: fA.id,
          folderLabel: fA.label,
          from: instA.instanceId,
          to: peer.instanceId,
          aToB,
          bToA,
          bidirectional: aToB && bToA,
        });
      }
    }
  }

  return c.json(200, {
    instances: managed.map((m) => ({
      instanceId: m.instanceId,
      name: m.name,
      syncthingId: m.syncthingId,
      error: m.error,
    })),
    links,
  });
});
