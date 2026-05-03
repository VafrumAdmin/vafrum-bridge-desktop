# LEGACY / DO NOT USE FOR NEW VAFRUM BRIDGE

> **Dieses Paket ist Legacy.**
>
> - Die neue Bridge liegt in `apps/vafrum-bridge` (Tauri v2 + Headless,
>   code-complete; siehe `apps/vafrum-bridge/README.md`).
> - **Nicht** für neue Features verwenden.
> - **Nicht** für Tauri/Desktop/Headless-Bridge weiterentwickeln.
> - Bleibt nur als historische Referenz auf den alten Electron/
>   Chromium-basierten Desktop-Build.
> - Status & nächste Schritte: `docs/project-completion-audit.md` und
>   `docs/production-bridge-migration-runbook.md`.

---

# Vafrum Bridge Desktop (legacy)

Alter Electron/Chromium-basierter Desktop-Wrapper für die Vafrum
Bridge. Größerer Installer, gebundlter Browser, ohne Tauri-v2-Skeleton.

Wird durch `apps/vafrum-bridge` ersetzt:

- Native Binaries via Tauri v2 (Rust-Shell + System-WebView).
- React + Tailwind nach `vafrum-core-web`-Konventionen.
- Headless-Service-Variante aus derselben `bridge-core`-Logik.
- Auto-Updater über signierte GitHub Releases.
- DEV/LIVE-Command-Authority + sanitized SecretStore.

## Was hier nicht weitergepflegt wird

- Keine neuen Connectoren, Endpunkte, Authority-Regeln.
- Keine Tauri-/Stronghold-/Hardware-Probe-Anpassungen.
- Keine Code-Signing-/Updater-Pipelines.
- Keine UI-Änderungen.

Der einzige Grund, hier noch reinzuschauen: ein historisches Verhalten
nachvollziehen oder eine alte Build-Pipeline migrieren. Sobald die neue
Bridge produktiv ausgerollt ist, kann dieses Paket archiviert werden.
