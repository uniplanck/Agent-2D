# Agent-2D

<p align="center">
  <a href="README.md#english">English</a> ·
  <a href="README.md#japanese">日本語</a> ·
  <a href="README.zh-CN.md">简体中文</a> ·
  <a href="README.zh-TW.md">繁體中文</a> ·
  <a href="README.ko.md">한국어</a> ·
  <a href="README.es.md">Español</a> ·
  <a href="README.fr.md">Français</a> ·
  <strong>Deutsch</strong> ·
  <a href="README.pt-BR.md">Português (Brasil)</a>
</p>

Agent-2D ist eine local-first 2D-Bildverarbeitungs-Engine für macOS auf Apple Silicon. Sie kombiniert Super Resolution, Komprimierung und Formatkonvertierung, benutzerdefinierte Größen und Ausschnitte, KI-Hintergrundentfernung, interaktive Objektbearbeitung sowie Raster-zu-SVG-Vektorisierung in einer Anwendung.

Desktop, CLI und MCP verwenden denselben Rust-Verarbeitungskern. Dadurch gibt es keine getrennten Bildverarbeitungsimplementierungen pro Oberfläche.

## Hauptfunktionen

| Funktion | Beschreibung | Haupt-Engine |
| --- | --- | --- |
| **Enhance** | 1× / 2× / 4× Super Resolution | Real-ESRGAN + NCNN/Vulkan |
| **Compress** | Komprimierung und Formatkonvertierung bei gleicher Auflösung | Rust-Pipeline + lokale Codecs |
| **Optimize** | Super Resolution mit anschließender Komprimierung | gemeinsame Rust-Pipeline |
| **Custom** | Exakte Ausgabegröße, Ausschnitt, Zoom, Position, Presets und optionale Dateigrößengrenze | gemeinsame Rust-Pipeline |
| **Remove BG** | Hochwertige transparente Freistellung | FeyNoBg + Alpha Matting |
| **Object Edit** | Auswahl per Klick, Negativ-Klick oder Box; Transparenz, Isolation und Entfernen mit Auffüllen | SAM 2.1 Base+ + Big-LaMa |
| **Vectorize** | Logos, Icons, Line Art und flache Illustrationen in echte SVG-Pfade umwandeln | VTracer |

Je nach Operation werden PNG, JPEG, WebP, AVIF und JPEG XL unterstützt. Dazu kommen Multi-Format-Export, Batch-Eingaben, Before/After-Vergleich, mehrere Themes und konfigurierbare Tastenkürzel.

## Voraussetzungen

Der aktuelle Entwicklungs- und Release-Validierungsumfang ist **macOS auf Apple Silicon**.

Für einen Build aus dem Quellcode werden benötigt:

- Rust **1.87+**
- Node.js **20+**
- Xcode Command Line Tools

Einige Format- und Komprimierungspfade verwenden lokal installierte Werkzeuge wie `ffmpeg`, `cwebp` oder `cjxl`. Große KI-Runtimes werden nicht im Repository gespeichert und nur nach einer expliziten Installation heruntergeladen.

## Desktop bauen

```bash
git clone https://github.com/uniplanck/Agent-2D.git
cd Agent-2D/apps/desktop
npm install
npm run typecheck
npm run release:app
```

Erzeugte App:

```text
target/release/bundle/macos/Agent-2D.app
```

DMG erzeugen:

```bash
npm run release:mac
```

Lokale Builds verwenden standardmäßig ad-hoc Signing. Für eine Verteilung an Dritte ohne Gatekeeper-Warnung werden ein Developer ID Application-Zertifikat und Apple Notarization benötigt.

## KI-Runtimes

### Super Resolution

```bash
cargo run -p agent2d-cli -- runtime-status
cargo run -p agent2d-cli -- runtime-install
cargo run -p agent2d-cli -- capabilities
```

### Hintergrund entfernen

```bash
cargo run -p agent2d-cli -- bg-runtime-status
cargo run -p agent2d-cli -- bg-runtime-install
cargo run -p agent2d-cli -- remove-bg input.jpg output.png --format png
```

### Object Edit

```bash
cargo run -p agent2d-cli -- object-runtime-status
cargo run -p agent2d-cli -- object-runtime-install
cargo run -p agent2d-cli -- object-mask input.png mask.png --include 320,240 --exclude 80,80 --expand 2 --feather 1
cargo run -p agent2d-cli -- object-edit input.png output.png --action make-selected-transparent --include 320,240 --format png
cargo run -p agent2d-cli -- object-edit input.png filled.png --action remove-and-fill --include 320,240 --format png
cargo run -p agent2d-cli -- object-bridge
```

`object-bridge` hält den Rust-Prozess und den SAM-Worker aktiv, damit wiederholte Auswahlen das Embedding des aktuellen Bildes wiederverwenden können. Der MCP-Server nutzt diese Bridge automatisch, solange er läuft.

## Custom-Beispiel

```bash
cargo run -p agent2d-cli -- custom input.png output.png \
  --width 1080 --height 1350 \
  --zoom 1.2 --x -0.1 --y 0.15 \
  --formats png,jpeg
```

## SVG-Vektorisierung

```bash
cargo run -p agent2d-cli -- vectorize input.png output.svg \
  --preset logo \
  --detail balanced \
  --max-colors 8
```

Die Ausgabe wird darauf geprüft, echte SVG-`<path>`-Geometrie zu enthalten und nicht nur ein eingebettetes Rasterbild.

## MCP Server

```bash
cd mcp/server
npm install
npm run typecheck
npm run build
npm run acceptance
```

Wichtige Tools:

```text
agent2d_inspect
agent2d_compress
agent2d_upscale
agent2d_enhance
agent2d_custom
agent2d_remove_background
agent2d_object_select
agent2d_object_edit
agent2d_vectorize
agent2d_optimize
agent2d_capabilities
```

## Local-first-Grenze

Die großen Modell-Dateien von Real-ESRGAN, FeyNoBg, SAM 2.1 und Big-LaMa werden nicht in Git eingecheckt. Sie werden nur dann von ihren Upstream-Quellen geladen, wenn ein Nutzer den jeweiligen Runtime-Install ausdrücklich startet. Nach der Installation ist die normale Verarbeitung für die lokale Ausführung ausgelegt.

## Lizenz

Der eigene Quellcode von Agent-2D steht unter der **MIT License**. Siehe [`LICENSE`](LICENSE).

Bibliotheken von Drittanbietern, Codecs, Runtime-Binaries und KI-Modellgewichte behalten ihre jeweiligen Upstream-Lizenzen und Bedingungen. Siehe [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

Die ausführlichste technische Dokumentation befindet sich in [`README.md`](README.md).
