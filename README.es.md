# Agent-2D

<p align="center">
  <a href="README.md#english">English</a> ·
  <a href="README.md#japanese">日本語</a> ·
  <a href="README.zh-CN.md">简体中文</a> ·
  <a href="README.zh-TW.md">繁體中文</a> ·
  <a href="README.ko.md">한국어</a> ·
  <strong>Español</strong> ·
  <a href="README.fr.md">Français</a> ·
  <a href="README.de.md">Deutsch</a> ·
  <a href="README.pt-BR.md">Português (Brasil)</a>
</p>

Agent-2D es un motor local-first de procesamiento de imágenes 2D para macOS con Apple Silicon. Reúne superresolución, compresión y conversión de formatos, encuadre personalizado, eliminación de fondo con IA, edición interactiva de objetos y vectorización raster-a-SVG en una sola aplicación.

Desktop, CLI y MCP comparten el mismo núcleo de procesamiento en Rust, por lo que no existen implementaciones separadas con resultados distintos según la interfaz.

La interfaz Desktop admite **日本語 / English / 简体中文 / 繁體中文 / 한국어 / Español / Français / Deutsch / Português (Brasil)**. Al elegir **System**, se utiliza el primer idioma compatible de la lista de idiomas preferidos de macOS.

## Descargar Agent-2D

Para usuarios normales de Mac con Apple Silicon, descarga **[Agent-2D-macOS-arm64.zip](https://github.com/uniplanck/Agent-2D/releases/latest/download/Agent-2D-macOS-arm64.zip)**, descomprímelo y abre **Agent-2D.app** con doble clic. Moverlo a `/Applications` es opcional. El uso normal de Desktop no requiere Rust, Node.js, Xcode Command Line Tools, Homebrew, npm, cargo ni Terminal.

La aplicación aún no está notarizada por Apple. Si macOS bloquea el primer inicio, usa **Control/clic derecho en Agent-2D.app → Abrir**; si sigue bloqueado, ve a **Ajustes del Sistema → Privacidad y seguridad → Abrir igualmente**. No se necesita ningún comando de Terminal.

Al usar por primera vez una función de IA como Enhance, Cutout u Object Edit, Agent-2D prepara por sí mismo Real-ESRGAN, FeyNoBg, SAM 2.1 y Big-LaMa. **Settings → AI Runtime** permite ver el estado y usar Install / Repair. Después, el procesamiento se realiza localmente.

## Funciones principales

| Función | Descripción | Motor principal |
| --- | --- | --- |
| **Enhance** | Superresolución 1× / 2× / 4× | Real-ESRGAN + NCNN/Vulkan |
| **Compress** | Compresión y conversión manteniendo dimensiones | Rust pipeline + codecs locales |
| **Optimize** | Superresolución seguida de compresión | Rust pipeline compartido |
| **Custom** | Tamaño exacto, encuadre, zoom, posición, presets y límite opcional de archivo | Rust pipeline compartido |
| **Remove BG** | Extracción transparente de alta calidad | FeyNoBg + alpha matting |
| **Object Edit** | Selección por clic, clic negativo o caja; transparencia, aislamiento y borrado con relleno | SAM 2.1 Base+ + Big-LaMa |
| **Vectorize** | Conversión de logos, iconos, line art e ilustraciones planas a paths SVG reales | VTracer |

También incluye rutas de entrada/salida para PNG, JPEG, WebP, AVIF y JPEG XL según la operación, exportación a varios formatos, procesamiento por lotes, comparación Before / After, temas y atajos configurables.

## Requisitos

El objetivo actual de desarrollo y validación es **macOS sobre Apple Silicon**.

Solo Developer / Contributor que compilen desde el código fuente necesitan:

- Rust **1.87+**
- Node.js **20+**
- Xcode Command Line Tools

Las rutas principales de salida PNG / JPEG / WebP / AVIF / TIFF / BMP del Release Desktop no requieren instalar codecs con Homebrew; la codificación AVIF está integrada en la aplicación Rust. Funciones opcionales como JPEG XL se ocultan de forma segura si falta su codec. Los runtimes grandes de IA no se incluyen en la app: Agent-2D los prepara en el primer uso y Settings → AI Runtime permite Install / Repair.

## Compilar desde el código fuente

Los siguientes pasos son solo para Developer / Contributor. Los usuarios normales deben usar el ZIP de Release anterior.

### Compilar Desktop

```bash
git clone https://github.com/uniplanck/Agent-2D.git
cd Agent-2D/apps/desktop
npm install
npm run typecheck
npm run release:app
```

Aplicación generada:

```text
target/aarch64-apple-darwin/release/bundle/macos/Agent-2D.app
```

Para generar un DMG:

```bash
npm run release:mac
```

La compilación local usa firma ad-hoc por defecto. Para distribuir a terceros sin advertencias de Gatekeeper se necesita un certificado Developer ID Application y notarización de Apple.

## Runtimes de IA

### Superresolución

```bash
cargo run -p agent2d-cli -- runtime-status
cargo run -p agent2d-cli -- runtime-install
cargo run -p agent2d-cli -- capabilities
```

### Eliminación de fondo

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

`object-bridge` mantiene vivos el proceso Rust y el worker de SAM para reutilizar el embedding de la imagen activa. El servidor MCP usa este bridge automáticamente mientras permanece en ejecución.

## Ejemplo Custom

```bash
cargo run -p agent2d-cli -- custom input.png output.png \
  --width 1080 --height 1350 \
  --zoom 1.2 --x -0.1 --y 0.15 \
  --formats png,jpeg
```

## Vectorización SVG

```bash
cargo run -p agent2d-cli -- vectorize input.png output.svg \
  --preset logo \
  --detail balanced \
  --max-colors 8
```

El resultado se valida para comprobar que contiene geometría SVG `<path>` real y no una imagen raster incrustada.

## MCP Server

```bash
cd mcp/server
npm install
npm run typecheck
npm run build
npm run acceptance
```

Herramientas principales:

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

## Límite local-first

Los modelos grandes de Real-ESRGAN, FeyNoBg, SAM 2.1 y Big-LaMa no se incluyen en el repositorio ni en el ZIP para usuarios. Al usar por primera vez una función relacionada, Agent-2D prepara el runtime necesario desde la fuente upstream; después, el procesamiento normal se ejecuta localmente.

## Licencia

El código propio de Agent-2D se publica bajo **MIT License**. Consulta [`LICENSE`](LICENSE).

Las librerías de terceros, codecs, runtimes binarios y pesos de modelos de IA mantienen sus propias licencias y condiciones upstream. Consulta [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

La documentación técnica más completa está en [`README.md`](README.md).
