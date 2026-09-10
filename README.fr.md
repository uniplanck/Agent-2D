# Agent-2D

<p align="center">
  <a href="README.md#english">English</a> ·
  <a href="README.md#japanese">日本語</a> ·
  <a href="README.zh-CN.md">简体中文</a> ·
  <a href="README.zh-TW.md">繁體中文</a> ·
  <a href="README.ko.md">한국어</a> ·
  <a href="README.es.md">Español</a> ·
  <strong>Français</strong> ·
  <a href="README.de.md">Deutsch</a> ·
  <a href="README.pt-BR.md">Português (Brasil)</a>
</p>

Agent-2D est un moteur local-first de traitement d’images 2D pour macOS Apple Silicon. Il réunit super-résolution, compression et conversion de formats, cadrage personnalisé, suppression d’arrière-plan par IA, édition interactive d’objets et vectorisation raster-vers-SVG dans une seule application.

Desktop, CLI et MCP partagent le même cœur de traitement Rust. Les différentes interfaces n’embarquent donc pas des implémentations d’image séparées susceptibles de produire des résultats divergents.

L’interface Desktop prend en charge **日本語 / English / 简体中文 / 繁體中文 / 한국어 / Español / Français / Deutsch / Português (Brasil)**. Avec **System**, la première langue prise en charge dans la liste des langues préférées de macOS est utilisée.

## Télécharger Agent-2D

Pour un utilisateur normal de Mac Apple Silicon, téléchargez **[Agent-2D-macOS-arm64.zip](https://github.com/uniplanck/Agent-2D/releases/latest/download/Agent-2D-macOS-arm64.zip)**, décompressez-le puis double-cliquez sur **Agent-2D.app**. Le déplacement vers `/Applications` est facultatif. L’usage normal de Desktop ne nécessite ni Rust, ni Node.js, ni Xcode Command Line Tools, ni Homebrew, npm, cargo ou Terminal.

L’application n’est pas encore notarized par Apple. Si macOS bloque le premier lancement, faites **Control/clic droit sur Agent-2D.app → Ouvrir** ; s’il reste bloqué, utilisez **Réglages Système → Confidentialité et sécurité → Ouvrir quand même**. Aucune commande Terminal n’est nécessaire.

Lors de la première utilisation d’Enhance, Restore, Cutout ou Object Edit, Agent-2D prépare lui-même Real-ESRGAN, FeyNoBg, SAM 2.1, Big-LaMa, GFPGAN et NAFNet. **Settings → AI Runtime** permet aussi de vérifier l’état et d’utiliser Install / Repair. Le traitement s’effectue ensuite localement.

## Fonctions principales

| Fonction | Description | Moteur principal |
| --- | --- | --- |
| **Enhance** | Super-résolution 1× / 2× / 4× | Real-ESRGAN + NCNN/Vulkan |
| **Restore** | Restaure les visages dégradés, réduit le bruit photo ou le flou de mouvement sans changer les dimensions | GFPGAN v1.4 / NAFNet SIDD / NAFNet GoPro |
| **Compress** | Compression et conversion sans changer les dimensions | pipeline Rust + codecs locaux |
| **Optimize** | Super-résolution suivie d’une compression | pipeline Rust partagé |
| **Custom** | Taille exacte, cadrage, zoom, position, presets et limite optionnelle de taille | pipeline Rust partagé |
| **Remove BG** | Extraction transparente de haute qualité | FeyNoBg + alpha matting |
| **Object Edit** | Sélection par clic/clic négatif/boîte, transparence, isolation et suppression avec remplissage | SAM 2.1 Base+ + Big-LaMa |
| **Vectorize** | Conversion de logos, icônes, line art et illustrations plates en vrais paths SVG | VTracer |

Agent-2D prend aussi en charge les chemins d’entrée/sortie PNG, JPEG, WebP, AVIF et JPEG XL selon l’opération, l’export multi-format, le traitement par lot, la comparaison Before / After, plusieurs thèmes et des raccourcis configurables.

## Prérequis

La cible actuelle de développement et de validation release est **macOS sur Apple Silicon**.

Seuls les Developer / Contributor qui compilent depuis les sources ont besoin de :

- Rust **1.87+**
- Node.js **20+**
- Xcode Command Line Tools

Les principales sorties PNG / JPEG / WebP / AVIF / TIFF / BMP du Release Desktop ne nécessitent pas l’installation manuelle de codecs via Homebrew ; l’encodage AVIF est intégré à l’application Rust. Les chemins optionnels comme JPEG XL sont masqués proprement si leur codec manque. Les gros runtimes IA ne sont pas inclus dans l’app : Agent-2D les prépare à la première utilisation et Settings → AI Runtime fournit Install / Repair.

## Compiler depuis les sources

Les étapes suivantes sont réservées aux Developer / Contributor. Les utilisateurs normaux doivent utiliser le ZIP de Release ci-dessus.

### Compiler Desktop

```bash
git clone https://github.com/uniplanck/Agent-2D.git
cd Agent-2D/apps/desktop
npm install
npm run typecheck
npm run release:app
```

Application générée :

```text
target/aarch64-apple-darwin/release/bundle/macos/Agent-2D.app
```

Pour créer un DMG :

```bash
npm run release:mac
```

La build locale utilise une signature ad-hoc par défaut. Une distribution tierce sans avertissement Gatekeeper nécessite un certificat Developer ID Application et la notarisation Apple.

## Runtimes IA

### Super-résolution

```bash
cargo run -p agent2d-cli -- runtime-status
cargo run -p agent2d-cli -- runtime-install
cargo run -p agent2d-cli -- capabilities
```

### Suppression de l’arrière-plan

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

`object-bridge` maintient le processus Rust et le worker SAM actifs afin de réutiliser l’embedding de l’image courante lors de sélections répétées. Le serveur MCP utilise automatiquement ce bridge tant qu’il reste lancé.

## Exemple Custom

```bash
cargo run -p agent2d-cli -- custom input.png output.png \
  --width 1080 --height 1350 \
  --zoom 1.2 --x -0.1 --y 0.15 \
  --formats png,jpeg
```

## Vectorisation SVG

```bash
cargo run -p agent2d-cli -- vectorize input.png output.svg \
  --preset logo \
  --detail balanced \
  --max-colors 8
```

Le résultat est vérifié pour contenir de vrais éléments SVG `<path>` plutôt qu’une image raster embarquée.

## Serveur MCP

```bash
cd mcp/server
npm install
npm run typecheck
npm run build
npm run acceptance
```

Outils principaux :

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

## Frontière local-first

Les gros modèles Real-ESRGAN, FeyNoBg, SAM 2.1 et Big-LaMa ne sont inclus ni dans le dépôt ni dans le ZIP utilisateur. À la première utilisation d’une fonction concernée, Agent-2D prépare le runtime requis depuis la source upstream ; ensuite, le traitement normal reste local.

## Licence

Le code propre à Agent-2D est publié sous **MIT License**. Voir [`LICENSE`](LICENSE).

Les bibliothèques tierces, codecs, runtimes binaires et poids de modèles IA conservent leurs licences et conditions upstream. Voir [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

La documentation technique la plus complète se trouve dans [`README.md`](README.md).
