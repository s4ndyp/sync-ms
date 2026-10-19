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
