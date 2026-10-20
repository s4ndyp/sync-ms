/// <reference path="../pb_data/types.d.ts" />

migrate(
  (app) => {
    const collection = app.findCollectionByNameOrId("instances");
    collection.fields.add(new NumberField({ name: "in_bytes_alltime", min: 0 }));
    collection.fields.add(new NumberField({ name: "out_bytes_alltime", min: 0 }));
    app.save(collection);

    const all = app.findAllRecords("instances");
    for (let i = 0; i < all.length; i++) {
      const rec = all[i];
      const id = rec.id;
      let samples = [];
      try {
        samples =
          app.findRecordsByFilter("transfer_samples", `instance = "${id}"`, "", 0, 0) || [];
      } catch (_) {
        samples = [];
      }
      let inSum = 0;
      let outSum = 0;
      for (let j = 0; j < samples.length; j++) {
        inSum += Number(samples[j].get("in_bytes_delta")) || 0;
        outSum += Number(samples[j].get("out_bytes_delta")) || 0;
      }
      rec.set("in_bytes_alltime", inSum);
      rec.set("out_bytes_alltime", outSum);
      app.save(rec);
    }
  },
  (app) => {
    const collection = app.findCollectionByNameOrId("instances");
    try {
      collection.fields.removeByName("in_bytes_alltime");
      collection.fields.removeByName("out_bytes_alltime");
      app.save(collection);
    } catch (_) {}
  }
);
