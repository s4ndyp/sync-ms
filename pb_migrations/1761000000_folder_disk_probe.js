/// <reference path="../pb_data/types.d.ts" />

migrate(
  (app) => {
    const open = "";
    const instances = app.findCollectionByNameOrId("instances");

    const folderDiskSamples = new Collection({
      type: "base",
      name: "folder_disk_samples",
      listRule: open,
      viewRule: open,
      createRule: open,
      updateRule: open,
      deleteRule: open,
      indexes: [
        "CREATE INDEX idx_folder_disk_instance ON folder_disk_samples (instance)",
        "CREATE INDEX idx_folder_disk_recorded ON folder_disk_samples (recorded_at)",
        "CREATE INDEX idx_folder_disk_inst_folder_time ON folder_disk_samples (instance, folder_id, recorded_at)",
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
        { type: "text", name: "folder_id", required: true, min: 1, max: 64 },
        { type: "text", name: "folder_label", max: 120 },
        { type: "date", name: "recorded_at", required: true },
        { type: "number", name: "free_bytes", min: 0 },
        { type: "number", name: "total_bytes", min: 0 },
        { type: "text", name: "source", max: 32 },
      ],
    });
    app.save(folderDiskSamples);

    instances.fields.add(
      new Field({
        type: "text",
        name: "disk_probe_host",
        max: 253,
      })
    );
    app.save(instances);
  },
  (app) => {
    try {
      const col = app.findCollectionByNameOrId("folder_disk_samples");
      app.delete(col);
    } catch (_) {}
    try {
      const instances = app.findCollectionByNameOrId("instances");
      instances.fields.removeByName("disk_probe_host");
      app.save(instances);
    } catch (_) {}
  }
);
