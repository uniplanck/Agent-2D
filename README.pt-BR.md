# Agent-2D

<p align="center">
  <a href="README.md#english">English</a> ·
  <a href="README.md#japanese">日本語</a> ·
  <a href="README.zh-CN.md">简体中文</a> ·
  <a href="README.zh-TW.md">繁體中文</a> ·
  <a href="README.ko.md">한국어</a> ·
  <a href="README.es.md">Español</a> ·
  <a href="README.fr.md">Français</a> ·
  <a href="README.de.md">Deutsch</a> ·
  <strong>Português (Brasil)</strong>
</p>

Agent-2D é um motor local-first de processamento de imagens 2D para macOS em Apple Silicon. Ele reúne super-resolução, compressão e conversão de formatos, enquadramento personalizado, remoção de fundo com IA, edição interativa de objetos e vetorização raster-para-SVG em um único aplicativo.

Desktop, CLI e MCP usam o mesmo núcleo de processamento em Rust. Assim, as interfaces não mantêm implementações de imagem independentes com comportamentos diferentes.

A interface Desktop oferece **日本語 / English / 简体中文 / 繁體中文 / 한국어 / Español / Français / Deutsch / Português (Brasil)**. Ao selecionar **System**, é usado o primeiro idioma compatível da lista de idiomas preferidos do macOS.

## Baixar Agent-2D

Usuários comuns de Mac com Apple Silicon devem baixar **[Agent-2D-macOS-arm64.zip](https://github.com/uniplanck/Agent-2D/releases/latest/download/Agent-2D-macOS-arm64.zip)**, descompactar e abrir **Agent-2D.app** com dois cliques. Mover para `/Applications` é opcional. O uso normal do Desktop não exige Rust, Node.js, Xcode Command Line Tools, Homebrew, npm, cargo nem Terminal.

O app ainda não possui notarization da Apple. Se o macOS bloquear a primeira abertura, use **Control/clique direito em Agent-2D.app → Abrir**; se continuar bloqueado, vá a **Ajustes do Sistema → Privacidade e Segurança → Abrir Mesmo Assim**. Nenhum comando de Terminal é necessário.

Na primeira utilização de Enhance, Cutout ou Object Edit, o próprio Agent-2D prepara Real-ESRGAN, FeyNoBg, SAM 2.1 e Big-LaMa. Em **Settings → AI Runtime** também é possível ver o estado e usar Install / Repair. Depois da instalação, o processamento ocorre localmente.

## Principais recursos

| Recurso | O que faz | Motor principal |
| --- | --- | --- |
| **Enhance** | Super-resolução 1× / 2× / 4× | Real-ESRGAN + NCNN/Vulkan |
| **Compress** | Compressão e conversão preservando as dimensões | pipeline Rust + codecs locais |
| **Optimize** | Super-resolução seguida de compressão | pipeline Rust compartilhado |
| **Custom** | Tamanho exato, enquadramento, zoom, posição, presets e limite opcional de arquivo | pipeline Rust compartilhado |
| **Remove BG** | Extração transparente de alta qualidade | FeyNoBg + alpha matting |
| **Object Edit** | Seleção por clique/clique negativo/caixa, transparência, isolamento e remoção com preenchimento | SAM 2.1 Base+ + Big-LaMa |
| **Vectorize** | Converte logos, ícones, line art e ilustrações planas em paths SVG reais | VTracer |

O aplicativo também inclui caminhos de entrada/saída para PNG, JPEG, WebP, AVIF e JPEG XL conforme a operação, exportação para vários formatos, processamento em lote, comparação Before / After, múltiplos temas e atalhos configuráveis.

## Requisitos

O alvo atual de desenvolvimento e validação de release é **macOS em Apple Silicon**.

Somente Developer / Contributor que compilam a partir do código-fonte precisam de:

- Rust **1.87+**
- Node.js **20+**
- Xcode Command Line Tools

As principais saídas PNG / JPEG / WebP / AVIF / TIFF / BMP do Release Desktop não exigem instalação manual de codecs pelo Homebrew; o encode AVIF é integrado ao app Rust. Caminhos opcionais como JPEG XL são ocultados com segurança quando o codec não está disponível. Os runtimes grandes de IA não ficam dentro do app: o Agent-2D os prepara no primeiro uso e Settings → AI Runtime oferece Install / Repair.

## Compilar a partir do código-fonte

As etapas abaixo são apenas para Developer / Contributor. Usuários comuns devem usar o ZIP de Release acima.

### Compilar o Desktop

```bash
git clone https://github.com/uniplanck/Agent-2D.git
cd Agent-2D/apps/desktop
npm install
npm run typecheck
npm run release:app
```

Aplicativo gerado:

```text
target/aarch64-apple-darwin/release/bundle/macos/Agent-2D.app
```

Para gerar um DMG:

```bash
npm run release:mac
```

A build local usa assinatura ad-hoc por padrão. Para distribuição a terceiros sem aviso do Gatekeeper, é necessário um certificado Developer ID Application e notarização da Apple.

## Runtimes de IA

### Super-resolução

```bash
cargo run -p agent2d-cli -- runtime-status
cargo run -p agent2d-cli -- runtime-install
cargo run -p agent2d-cli -- capabilities
```

### Remoção de fundo

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

`object-bridge` mantém o processo Rust e o worker do SAM ativos para que seleções repetidas reutilizem o embedding da imagem atual. O MCP Server usa essa bridge automaticamente enquanto estiver em execução.

## Exemplo de Custom

```bash
cargo run -p agent2d-cli -- custom input.png output.png \
  --width 1080 --height 1350 \
  --zoom 1.2 --x -0.1 --y 0.15 \
  --formats png,jpeg
```

## Vetorização SVG

```bash
cargo run -p agent2d-cli -- vectorize input.png output.svg \
  --preset logo \
  --detail balanced \
  --max-colors 8
```

A saída é verificada para conter geometria SVG `<path>` real, em vez de apenas incorporar a imagem raster original.

## MCP Server

```bash
cd mcp/server
npm install
npm run typecheck
npm run build
npm run acceptance
```

Principais ferramentas:

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

## Limite local-first

Os grandes modelos Real-ESRGAN, FeyNoBg, SAM 2.1 e Big-LaMa não ficam no repositório nem no ZIP para usuários. No primeiro uso de um recurso relacionado, o Agent-2D prepara o runtime necessário a partir da fonte upstream; depois disso, o processamento normal permanece local.

## Licença

O código próprio do Agent-2D é publicado sob a **MIT License**. Consulte [`LICENSE`](LICENSE).

Bibliotecas de terceiros, codecs, runtimes binários e pesos de modelos de IA continuam sujeitos às respectivas licenças e condições upstream. Consulte [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

A documentação técnica mais completa está em [`README.md`](README.md).
