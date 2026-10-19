/// <reference path="../pb_data/types.d.ts" />

migrate(
  (app) => {
    const open = "";

    const instances = new Collection({
      type: "base",
      name: "instances",
      listRule: open,
      viewRule: open,
      createRule: open,
      updateRule: open,
      deleteRule: open,
      indexes: [
        "CREATE INDEX idx_instances_enabled ON instances (enabled)",
        "CREATE INDEX idx_instances_name ON instances (name)",
      ],
      fields: [
        { type: "text", name: "name", required: true, min: 1, max: 120 },
        { type: "url", name: "base_url", required: true, exceptDomains: [], onlyDomains: [] },
        { type: "text", name: "api_key", required: true, min: 1, max: 256 },
        { type: "bool", name: "enabled" },
        { type: "text", name: "syncthing_id", max: 80 },
        { type: "number", name: "last_event_id", min: 0 },
        { type: "bool", name: "online" },
        { type: "date", name: "last_seen" },
        { type: "text", name: "last_error", max: 500 },
        { type: "number", name: "in_bytes_total", min: 0 },
        { type: "number", name: "out_bytes_total", min: 0 },
        { type: "number", name: "in_speed_bps", min: 0 },
        { type: "number", name: "out_speed_bps", min: 0 },
        { type: "text", name: "version", max: 32 },
        { type: "number", name: "sample_count", min: 0 },
        { type: "date", name: "last_sample_at" },
      ],
    });
    app.save(instances);

    const transferSamples = new Collection({
      type: "base",
      name: "transfer_samples",
      listRule: open,
      viewRule: open,
      createRule: open,
      updateRule: open,
      deleteRule: open,
      indexes: [
        "CREATE INDEX idx_samples_instance ON transfer_samples (instance)",
        "CREATE INDEX idx_samples_recorded ON transfer_samples (recorded_at)",
        "CREATE INDEX idx_samples_instance_time ON transfer_samples (instance, recorded_at)",
      ],
      fields: [
        {
          type: "relation",
          name: "instance",
          required: true,
          maxSelect: 1,
          collectionId: instances.id,
          cascadeDelete: true,
        },
        { type: "date", name: "recorded_at", required: true },
        { type: "number", name: "in_bytes_total", min: 0 },
        { type: "number", name: "out_bytes_total", min: 0 },
        { type: "number", name: "in_bytes_delta", min: 0 },
        { type: "number", name: "out_bytes_delta", min: 0 },
        { type: "number", name: "in_speed_bps", min: 0 },
        { type: "number", name: "out_speed_bps", min: 0 },
      ],
    });
    app.save(transferSamples);

    const transferHourly = new Collection({
      type: "base",
      name: "transfer_hourly",
      listRule: open,
      viewRule: open,
      createRule: open,
      updateRule: open,
      deleteRule: open,
      indexes: [
        "CREATE UNIQUE INDEX idx_hourly_bucket ON transfer_hourly (instance, bucket_start)",
        "CREATE INDEX idx_hourly_start ON transfer_hourly (bucket_start)",
      ],
      fields: [
        {
          type: "relation",
          name: "instance",
          required: true,
          maxSelect: 1,
          collectionId: instances.id,
          cascadeDelete: true,
        },
        { type: "date", name: "bucket_start", required: true },
        { type: "number", name: "in_bytes_delta", min: 0 },
        { type: "number", name: "out_bytes_delta", min: 0 },
      ],
    });
    app.save(transferHourly);
  },
  (app) => {
    const names = ["transfer_hourly", "transfer_samples", "instances"];
    for (const name of names) {
      try {
        const col = app.findCollectionByNameOrId(name);
        app.delete(col);
      } catch (_) {}
    }
  }
);
