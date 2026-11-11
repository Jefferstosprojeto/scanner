# Scanner de Documentos (web app / PWA)

Escaneie documentos com a câmera do iPhone, corrija a perspectiva, aplique filtros,
junte várias páginas num PDF e compartilhe por WhatsApp, e-mail etc.

## Funcionalidades
- **Ferramentas**: Escanear, Mega Scan (sequência), Assinar, Para Word (texto editável ou imagens), Para Excel, Extrair texto, Traduzir, QR Code, Data e hora, RG/Carteira (frente e verso numa A4), Livro (divide página dupla), Quadro branco, Slides, Restaurar foto
- **Em breve**: Foto 3x4, Apagar inteligente, Lista de questões, CountCam
- Foto pela **câmera** ou várias imagens da **galeria** (recorte automático em lote)
- **Detecção automática das bordas** do papel (OpenCV.js, baixado na 1ª vez e guardado em cache)
- Ajuste manual dos 4 cantos com **lupa**
- **Correção de perspectiva** (a folha fica reta, mesmo fotografada de lado)
- Filtros: **Original**, **Realçar** (papel branco, sem sombras), **Cinza**, **P&B**
- Girar, reordenar, editar e excluir páginas
- PDF em **A4**, **Carta** ou no tamanho da imagem, com qualidade **Alta / Média / Pequena**
- **Compartilhar** pelo menu nativo do iOS (WhatsApp, Mail, Arquivos…) ou **Baixar**
- Páginas ficam salvas **só no aparelho** (IndexedDB); nada é enviado para servidor
- Funciona **offline** e pode ser instalado na tela de início

## Estrutura
```
index.html            telas e folhas
css/style.css         visual (claro/escuro automático)
js/app.js             fluxo do app (telas, páginas, PDF, compartilhar)
js/imaging.js         perspectiva, filtros, rotação (Canvas puro)
js/detect.js          detecção de bordas (OpenCV.js sob demanda)
js/storage.js         persistência local (IndexedDB)
sw.js                 cache offline
manifest.webmanifest  instalação como app
icons/                ícones
```

## Testar no computador
```
python -m http.server 8765
```
Abra http://localhost:8765

## Usar no iPhone (precisa de HTTPS)
A câmera, o compartilhamento e o modo offline exigem HTTPS. O jeito mais simples e gratuito é o **GitHub Pages**:

1. Crie um repositório no GitHub (ex.: `scanner`) e envie estes arquivos.
2. No repositório: **Settings → Pages → Source: Deploy from a branch → `main` / root**.
3. Em ~1 minuto o app fica em `https://SEU-USUARIO.github.io/scanner/`.
4. No iPhone, abra esse link no **Safari** → botão **Compartilhar** → **Adicionar à Tela de Início**.

Alternativas: Netlify Drop (arrastar a pasta em app.netlify.com/drop) ou Cloudflare Pages.

## Atualizar o app
Ao alterar arquivos, troque `VERSION` em `sw.js` (ex.: `scanner-v2`) para os aparelhos baixarem a nova versão.
