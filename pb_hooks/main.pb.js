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

routerAdd("POST", "/api/syncms/test-connection", (c) => {
  const body = readJson(c);
  const baseUrl = normalizeBaseUrl(body.base_url);
  const apiKey = String(body.api_key || "").trim();

  if (!baseUrl || !apiKey) {
    return c.json(400, { ok: false, error: "base_url en api_key zijn verplicht" });
  }

  let versionRes;
  try {
    versionRes = $http.send({
      url: `${baseUrl}/rest/system/version`,
      method: "GET",
      headers: { "X-API-Key": apiKey },
      timeout: 20,
    });
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
    const statusRes = $http.send({
      url: `${baseUrl}/rest/system/status`,
      method: "GET",
      headers: { "X-API-Key": apiKey },
      timeout: 20,
    });
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
