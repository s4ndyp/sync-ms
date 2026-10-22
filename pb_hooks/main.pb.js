/// <reference path="../pb_data/types.d.ts" />

// Route handlers run in an isolated JSVM scope; load shared logic via require().
// https://pocketbase.io/docs/js-overview/#handlers-scope

routerAdd("POST", "/api/syncms/test-connection", (c) => {
  const api = require(`${__hooks}/syncms_api.js`);
  return api.testConnection(c);
});

routerAdd("GET", "/api/syncms/topology", (c) => {
  const api = require(`${__hooks}/syncms_api.js`);
  return api.topology(c);
});

routerAdd("GET", "/api/syncms/config/backup", (c) => {
  const api = require(`${__hooks}/syncms_api.js`);
  return api.backupConfig(c);
});

routerAdd("POST", "/api/syncms/config/restore", (c) => {
  const api = require(`${__hooks}/syncms_api.js`);
  return api.restoreConfig(c);
});

routerAdd("GET", "/api/syncms/instances/{instanceId}/browse", (c) => {
  const api = require(`${__hooks}/syncms_api.js`);
  return api.instanceBrowse(c);
});

routerAdd("GET", "/api/syncms/instances/{instanceId}/folders", (c) => {
  const api = require(`${__hooks}/syncms_api.js`);
  return api.instanceFolders(c);
});

routerAdd("POST", "/api/syncms/instances/{instanceId}/folder-disk", (c) => {
  const api = require(`${__hooks}/syncms_api.js`);
  return api.pushFolderDisk(c);
});

routerAdd("POST", "/api/syncms/instances/{instanceId}/add-folder", (c) => {
  const api = require(`${__hooks}/syncms_api.js`);
  return api.applyAddFolder(c);
});

routerAdd("POST", "/api/syncms/instances/{instanceId}/share-folder", (c) => {
  const api = require(`${__hooks}/syncms_api.js`);
  return api.applyFolderShare(c);
});

routerAdd("POST", "/api/syncms/auto-pair-devices", (c) => {
  const api = require(`${__hooks}/syncms_api.js`);
  return api.autoPairDevices(c);
});
