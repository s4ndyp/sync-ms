# Sync-MS

Management server voor meerdere **Syncthing**-installaties: donker webdashboard, **PocketBase** als opslag, geen login (alleen voor vertrouwd netwerk / achter reverse proxy).

## Functies

- Instances beheren (GUI-URL + API key per Syncthing-node)
- Live status via **long-poll** op `/rest/events` (efficiënter dan kort poll-interval)
- Transferstatistiek via periodieke samples van `/rest/system/connections` (standaard elke 60s)
- **Snelheid** berekend uit byte-delta tussen opeenvolgende metingen
- Staafdiagrammen: 24u, 7 dagen, maand, all-time (+ lijngrafiek snelheid)
- Uuraggregaten voor langere periodes

Syncthing stuurt geen webhooks naar externe servers; de REST **events API** is long-polling (blokkeert tot ~60s bij wijzigingen). Sync-MS combineert dat met interval-samples voor betrouwbare byte-tellingen.

## Docker (Proxmox LXC)

```bash
curl -fsSL -o docker-compose.yml \
  https://raw.githubusercontent.com/s4ndyp/sync-ms/main/docker-compose.yml
docker compose up -d
```

Dashboard: `http://<host>:8096`

Image: `ghcr.io/s4ndyp/sync-ms:latest`

### Omgevingsvariabelen

| Variabele | Default | Beschrijving |
|-----------|---------|--------------|
| `SYNCMS_HTTP_PORT` | `8096` | Host-poort (compose) |
| `SYNCMS_SAMPLE_INTERVAL_SEC` | `60` | Interval connection-samples |
| `SYNCMS_RETENTION_DAYS` | `45` | Ruwe samples bewaren |

## Syncthing voorbereiden

1. Open Syncthing GUI → **Instellingen → API**
2. Genereer een API key
3. In Sync-MS: **Instance toevoegen** met `http://ip:8384` (of HTTPS) en de key
4. Zorg dat de management-server de GUI-poort kan bereiken (firewall / Docker-netwerk)

## Community-scripts (LXC)

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/s4ndyp/sync-ms/main/deploy/sync-ms-install.sh)"
```

Dit volgt hetzelfde patroon als [tracknote](https://github.com/s4ndyp/scripts/tree/main/tracknote).

## Ontwikkeling

```bash
go run ./cmd/collector   # lokaal; PocketBase apart starten
docker build -t sync-ms:dev .
```

Migraties staan in `pb_migrations/`; UI in `web/` (wordt `pb_public` in de image).

## CI/CD

- **build.yml**: test/build op PR; push naar `main`/`beta` → GHCR
- Feature branches: automatisch draft-PR naar `main` (behalve `beta`)

## Architectuur

```
Browser → PocketBase (8090) → pb_public UI + API
                ↑
         syncms-collector → Syncthing REST (events + connections)
```

Data: `instances`, `transfer_samples`, `transfer_hourly`, `folder_disk_samples`.

### Vrije schijfruimte per Syncthing-map

Syncthing REST levert geen vrije schijfruimte. De **Sync-MS-server leest geen paden op Syncthing-hosts**; elke Syncthing-client draait een kleine **agent** die lokaal `df` doet en metingen stuurt naar `folder_disk_samples`.

**Op elke Syncthing-host** (eenmalig):

```bash
git clone https://github.com/s4ndyp/sync-ms.git   # of kopieer alleen scripts/ + deploy/
cd sync-ms
sudo bash deploy/install-folder-disk-agent.sh
sudo nano /etc/sync-ms/folder-disk.env   # SYNC_MS_URL + SYNCTHING_API_KEY
sudo sync-ms-folder-disk-agent           # test
```

De agent:

- leest Syncthing `/rest/config/folders` en meet vrije ruimte op elk map-pad;
- koppelt aan Sync-MS via **Syncthing device ID** (`myID`) — zorg dat de instance in Sync-MS al `syncthing_id` heeft (collector of **Verbinding testen**);
- optioneel extra paden in `/etc/sync-ms/folder-disk-extra.paths` (`folder_id|label|pad`).

API (door de agent gebruikt): `POST /api/syncms/folder-disk-report` met `device_id` + `folders[]`. Handmatig kan ook `POST /api/syncms/instances/{id}/folder-disk`.

In het dashboard volgen de grafieken per map dezelfde instance- en periode-filters als “Transferred bytes”.
