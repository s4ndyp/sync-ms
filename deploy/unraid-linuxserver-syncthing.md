# Unraid + linuxserver/syncthing — disk probe

Sync-MS pollt **`http://<host>:8765`** (geen auth). De probe moet **dezelfde container-paden** zien als Syncthing (bijv. `/data/...`), niet alleen Unraid host-paden.

Kies **één** van onderstaande methodes per Syncthing-instance.

---

## Methode A — Sidecar container (aanbevolen)

Geen binary in de Syncthing-container; aparte container met **identieke volume mappings** als je Syncthing-mappen.

### Image

Na merge naar `main` (CI):

```text
ghcr.io/s4ndyp/sync-ms:disk-probe
```

(Beta branch: `ghcr.io/s4ndyp/sync-ms:disk-probe-beta`.)

### Unraid — Add Container

| Veld | Waarde |
|------|--------|
| Name | `syncthing-disk-probe` (of per instance uniek) |
| Repository | `ghcr.io/s4ndyp/sync-ms:disk-probe` |
| Network Type | `bridge` |
| Port | `8765` → `8765` (TCP) — 2e instance: host `8766` → container `8765` |
| Restart | `unless-stopped` |

**Volume mappings:** kopieer van je **linuxserver/syncthing** container alle paden die in Syncthing als map-pad voorkomen (bijv. `/mnt/user/media` → `/data`). **`/config` hoeft niet** op de probe.

Voorbeeld: Syncthing heeft

```text
/mnt/user/appdata/syncthing → /config
/mnt/user/media             → /data
```

Probe krijgt alleen:

```text
/mnt/user/media → /data
```

### Sync-MS

- Syncthing API URL: ongewijzigd (bijv. `http://<unraid-ip>:8384`).
- **Disk probe host:** leeg als poort 8765 op Unraid-IP; bij 2e instance bijv. `http://<unraid-ip>:8766`.

Test op Unraid:

```bash
curl -s http://127.0.0.1:8765/health
```

---

## Methode B — Binary + LSIO custom service (in Syncthing-container)

Zie eerdere stappen: binary in `/config`, mount `/custom-services.d`, poort 8765 in Syncthing-template.

Handig als je geen extra container wilt.

---

## Twee Syncthing-instances op één Unraid

| Instance | Syncthing poort (GUI) | Probe host-poort | Sync-MS `disk_probe_host` |
|----------|------------------------|------------------|---------------------------|
| 1 | 8384 | 8765 | (leeg) |
| 2 | 8385 (of andere host map) | 8766 | `http://<unraid-ip>:8766` |

Elke instance: eigen sidecar **of** eigen custom service + eigen poortmapping.

---

## Compose-voorbeeld (sidecar)

```yaml
services:
  syncthing:
    image: lscr.io/linuxserver/syncthing:latest
    container_name: syncthing
    environment:
      - PUID=1000
      - PGID=1000
      - TZ=Europe/Amsterdam
    volumes:
      - /mnt/user/appdata/syncthing:/config
      - /mnt/user/media:/data
    ports:
      - 8384:8384
      - 22000:22000/tcp
      - 22000:22000/udp
    restart: unless-stopped

  syncthing-disk-probe:
    image: ghcr.io/s4ndyp/sync-ms:disk-probe
    container_name: syncthing-disk-probe
    volumes:
      - /mnt/user/media:/data
    ports:
      - 8765:8765
    restart: unless-stopped
```

---

## Troubleshooting

- **`test-disk-probe` → healthOk false:** firewall of verkeerde host/poort; probe bereikbaar vanaf de Sync-MS-server?
- **usage errors “path not accessible”:** volume mapping ontbreekt of pad in Syncthing wijkt af (bijv. `/data/foo` vs `/mnt/...`).
- **Image pull 404:** wacht op CI na merge, of gebruik GitHub Release binary + methode B.
