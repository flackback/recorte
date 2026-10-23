# Recorte

Gravador de tela e editor para Windows, feito com Tauri 2 (Rust + TypeScript, WebGPU).

> **Inspirado no [Slice](https://github.com/rit3zh/Slice), de [rit3zh](https://github.com/rit3zh)**, um gravador de tela e editor para macOS ([slice.rit3zh.dev](https://slice.rit3zh.dev)). O Recorte é um projeto independente para Windows, escrito do zero: não contém código, ícones nem outros arquivos do Slice. As ideias de recursos vêm dele. Veja [Créditos](#créditos).

## Gravação

- **Fontes:** tela inteira, janela ou **área**, a 30, 60 ou 120 fps. Ao escolher "Área" (ou clicar numa tela nesse modo), a seleção abre na hora para você desenhar o retângulo; a área fica desenhada no mapa das telas, com "Alterar área", e o app lembra dela para as próximas gravações. Usa Windows.Graphics.Capture com H.264 por hardware.
- **Áudio do sistema:** loopback WASAPI, num WAV próprio (`system.wav`); preenchido com silêncio quando nada toca. Gravações antigas têm esse áudio dentro do MP4, e o app lê os dois formatos.
- **Microfone:** faixa separada (`mic.wav`).
- **Webcam:** gravada pelo WebView em `webcam.mp4`, alinhada à tela pelo mesmo relógio.
- **Mouse:** posição, cliques e formato do cursor (seta, mão, texto) em `cursor.json`.
- **Teclas:** opcional, em `keys.json`. Atenção: grava tudo o que for digitado, inclusive senhas.
- **Desenhar na tela durante a gravação:** as ferramentas ficam na própria barra flutuante, que não aparece no vídeo. Só os desenhos entram.
  - Ferramentas: mouse, caneta, linha, seta, seta tracejada (com tracejado animado), retângulo, círculo, marca-texto e texto.
  - 5 cores, 3 espessuras, desfazer (Ctrl+Z), apagar tudo (Delete) e "sumir sozinho" (cada desenho some 3 s depois de feito).
  - Atalhos enquanto desenha: P, L, A, D, R, E, M, T; **Esc** volta ao mouse e os desenhos ficam. Shift deixa linhas em 45° e formas quadradas ou redondas.
  - **Ctrl+Shift+D** abre e fecha a bandeja de ferramentas de qualquer programa. A barra pode ser arrastada pela alça à esquerda.
- **Gravar e parar de qualquer programa:** atalho global **Alt+Shift+R** (usa a fonte escolhida no app). **Ctrl+Shift+X** também para. O atalho não é Ctrl+Shift+R porque esse recarrega páginas nos navegadores.
- **Marcar momentos:** **Alt+Shift+M** ou o botão "Marcar" da barra flutuante. As marcas aparecem como bandeiras na régua da timeline; clicar perto de uma vai até ela.
- **Janela do app:** fica fora da gravação. Fora da gravação, ela aparece normalmente em compartilhamento de tela e acesso remoto (AnyDesk, Meet).
- **Contagem 3-2-1** na tela escolhida antes de começar (chip "Contagem"; Esc cancela, clique começa na hora).
- **Barra flutuante** durante a gravação, fora do vídeo: tempo, Pausar/Continuar, Marcar, Desenhar (abre a bandeja de ferramentas) e Parar. O app se minimiza e volta sozinho ao parar.
- **Pausar:** a gravação continua por baixo e o trecho pausado já abre cortado no editor.
- **Proteção contra travamentos:**
  - o vídeo é gravado em segmentos de 30 s, cada um finalizado; ao parar, o app junta os segmentos em `screen.mp4` sem recodificar;
  - os WAVs atualizam o cabeçalho a cada 2 s, e os eventos do mouse e das teclas vão para o disco a cada 2 s;
  - se o app ou o Windows travar, ao abrir de novo o app recupera a gravação até o último segmento completo e mostra "Gravação recuperada", com um aviso do que se perdeu (no máximo 30 s).
- **Gravações longas:** a exportação, as miniaturas, a forma de onda, a transcrição e a junção leem os arquivos em partes. Uma gravação de 30 minutos (836 MB) abre no editor em cerca de 16 s, usando cerca de 60 MB de memória do JavaScript.

## Editor

- **Estilos prontos:** Tutorial, Vertical (9:16), Minimalista, Apresentação, Produto 3D e Sem efeitos, num clique, sem mexer em cortes e zooms.
- **Visual:** fundos em degradê ou imagem (com desfoque), margem, cantos, sombra, proporção (original, 16:9, 9:16, 1:1, 4:3), moldura de janela ou notebook, inclinação 3D, recorte de área.
- **Cursor:**
  - redesenhado e suavizado, com tamanho ajustável e o formato real (seta, mão, texto);
  - "aperto" e anel ao clicar, destaque (spotlight) ao clicar e som de clique;
  - teclas na tela: só atalhos ou tudo o que foi digitado, com som de teclado.
- **Zoom:**
  - automático a partir dos cliques, com a câmera seguindo o cursor;
  - lente de aumento ("vidro") que acompanha o cursor;
  - trechos editáveis na timeline.
- **Timeline:**
  - arraste sobre o vídeo para selecionar um trecho; Delete (ou X) corta, e Zoom, Lente e Desfocar usam o trecho;
  - miniaturas, forma de onda e cliques no vídeo;
  - corte do início e do fim, e faixas de cortes, velocidade, zoom e lente, textos e desfoque;
  - itens que acontecem ao mesmo tempo (um texto com uma seta) ficam em linhas separadas na faixa;
  - Ctrl + roda aproxima.
- **Desfoque de áreas:** para esconder informações sensíveis, por intervalo de tempo.
- **Acelerar trechos:** 1,5×, 2×, 4× ou 8× (botão Acelerar ou tecla S), para digitação e telas de carregamento. O som do trecho acelerado fica mudo.
- **Textos, setas e destaques:** por trecho (botão Texto ou tecla T), com cor, tamanho e posição arrastada na prévia. Ficam fixos no quadro final, mesmo com zoom.
- **Abertura e encerramento:** telas de título no começo e no fim, no fundo do estilo, com transição suave (aba Visual).
- **Limpeza automática** (aba Trechos):
  - "Tirar silêncios" acha os silêncios pelo áudio (microfone ou som da gravação) e corta, com folga para a fala não ficar colada;
  - "Tirar hã, hum e é longo" corta hesitações da transcrição. O "é" curto (verbo) fica.
- **Webcam:** bolha em círculo ou quadrado, num dos quatro cantos.
- **Áudio:**
  - volume do sistema e do microfone;
  - "Melhorar a voz", que remove ruído com RNNoise, corta graves, comprime e normaliza;
  - música de fundo com fade no final.
- **Texto:**
  - transcrição offline com Whisper, rodando no WebView via WebGPU, no idioma escolhido (português, inglês, espanhol, francês, alemão ou italiano);
  - legendas com a palavra atual destacada;
  - cortar o vídeo apagando palavras no texto.
- Desfazer e refazer, salvamento automático e avisos com "Desfazer".
- Atalhos de teclado no botão de teclado da barra do editor (ou tecla `?`).

## Menus de contexto (botão direito)

- **Gravação na lista:** Abrir, Renomear (F2 ou clique duplo), Mostrar na pasta, Exportar…, Mover para a Lixeira (com confirmação; dá para restaurar pela Lixeira do Windows).
- **Várias gravações:** Ctrl+clique seleciona uma a uma, Shift+clique seleciona uma sequência e Ctrl+A seleciona todas. A faixa acima da lista e o botão direito movem as selecionadas para a Lixeira de uma vez; Esc tira a seleção.
- **Monitor no seletor:** gravar esta tela, escolher uma área nela.
- **Janela no seletor:** gravar esta janela.
- **Trecho na timeline:** ir para o início/fim, trocar zoom ↔ lente, aumentar/diminuir, ajustar a área do desfoque, remover.
- **Faixa vazia:** adicionar corte, zoom, lente ou desfoque naquele ponto.
- **Vídeo na timeline:** reproduzir dali, começar/terminar o vídeo ali, restaurar início e fim.
- **Prévia:** reproduzir/pausar, zoom, lente, desfoque, corte, recortar área, exportar.
- **Palavra na transcrição:** ir até ela, cortar ou restaurar a seleção, restaurar todas.
- **Barra de título:** minimizar, maximizar/restaurar, procurar atualizações (com a versão atual), fechar.

## Janela

- Sem a barra do Windows: título, minimizar, maximizar e fechar são do próprio app.
- Cantos arredondados e borda fina; ao maximizar, os cantos ficam retos.
- Gravações sem nome aparecem como "Tela inteira", "Área da tela" ou o título da janela gravada, com data e duração.
- Sem gravação aberta, o editor mostra "Gravar agora" e "Abrir a última gravação".

## Configurações

- **Edição por IA:** estado do servidor MCP, Node.js, Claude Code e Claude Desktop, com botões para conectar; liga e desliga o acesso da IA.
- **Gravação:** pasta das gravações, atalhos globais e "Rever dicas".
- **Atualizações:** versão instalada, procurar agora, procurar sozinho (liga e desliga) e novidades.
- **Sobre:** versão e link do código.

## Primeiro uso

- **Dicas guiadas:** na primeira vez que o app abre e na primeira edição, balões apontam o que importa (escolher a fonte, gravar, cortar arrastando, estilos, botão direito, exportar). "Rever dicas" fica na janela de atalhos.
- **Abertura animada:** o ícone se monta (quadrado, cantos de recorte, ponto de gravação) e se dissolve no app; com "reduzir movimento" do Windows ligado, vira um fade curto.
- **Ícone:** `src-tauri/icons/source.svg` é a fonte; os demais tamanhos saem com `npx tauri icon src-tauri/icons/source.svg`.

## Exportação

- **MP4:** H.264 + AAC, de 720p a 4K, a 30, 60 ou 120 fps, com tamanho estimado, progresso, tempo restante e cancelar.
- **Destinos prontos:** YouTube (1080p), Reels/TikTok/Shorts (vertical 9:16), WhatsApp (até 16 MB) e Discord (até 10 MB). Nos dois últimos, a qualidade se ajusta para caber no limite, e o app avisa quando o vídeo é longo demais para ele.
- **GIF:** de 480 a 960 px, a 10, 15 ou 20 fps.
- **Mesma imagem da prévia:** usa o mesmo renderizador WebGPU, então o arquivo sai igual ao que aparece no editor.
- **Destino:** os arquivos ficam em `Vídeos\Recorte\Exportados`.
- **Opções coerentes com a gravação:** resoluções e fps acima do que foi gravado não são oferecidos.

## Edição por IA (servidor MCP)

O Recorte tem um servidor MCP. Com ele, uma IA (Claude Code, Claude Desktop ou outro cliente MCP) lê, edita e exporta as gravações.

### Ferramentas

| Grupo | Ferramentas |
|---|---|
| Ler | `list_takes`, `get_take`, `get_transcript`, `get_activity` (cliques, rolagem, teclas), `find_pauses` |
| Cortar | `set_trim`, `add_cuts`, `remove_cuts`, `cut_words`, `restore_words`, `remove_silences`, `cut_fillers` |
| Velocidade | `add_speed`, `remove_speeds` |
| Zoom e desfoque | `add_zoom` (zoom ou lente), `auto_zoom`, `remove_zooms`, `add_blur`, `remove_blurs`, `update_item` |
| Textos e telas | `add_note`, `update_note`, `remove_notes`, `set_title_cards` |
| Aparência e áudio | `apply_style`, `update_settings`, `set_background_image`, `set_music` |
| Gravação | `rename_take`, `undo_last_edit`, `reset_edit` |
| App | `app_status`, `open_in_editor`, `transcribe`, `export_video` |

### Como funciona

- As edições vão para o `project.json` da gravação. O app não precisa estar aberto para isso.
- Com o app aberto e a gravação no editor, a mudança aparece na hora, com um aviso e o botão "Desfazer". Ctrl+Z também desfaz.
- `undo_last_edit` desfaz a última edição da IA. Ele recusa se você mudou a edição depois, para não perder o seu trabalho.
- `transcribe`, `export_video` (com destinos prontos: youtube, vertical, whatsapp, discord), `remove_silences`, `open_in_editor` e "Melhorar a voz" precisam do app aberto. A IA recebe o progresso e, no fim, o caminho do arquivo.
- Todos os tempos são em milissegundos, na linha do tempo da gravação original.

### Conectar pelo app

Abra **Configurações** (engrenagem na barra de título ou **Ctrl+,**) → **Edição por IA**. A tela mostra:

- se a IA pode usar o app (um botão liga e desliga o canal local);
- onde está o servidor MCP, que vem junto com o app instalado;
- se o Node.js está instalado (o servidor precisa dele);
- se o Claude Code e o Claude Desktop já conhecem o Recorte, com um botão **Conectar** para cada um;
- exemplos de pedidos e o comando ou a configuração para conectar outros programas.

### Instalar à mão (desenvolvimento)

1. Gere o servidor: `npm run build:mcp`. O arquivo fica em `mcp/dist/recorte-mcp.mjs`.
2. Registre no Claude Code, para todas as pastas: `claude mcp add --scope user recorte -- node E:/slice/mcp/dist/recorte-mcp.mjs`.
3. Confira com `claude mcp get recorte`. O estado deve ser "Connected".
4. No Claude Desktop (aba de chat), adicione em `claude_desktop_config.json`: `"recorte": { "command": "node", "args": ["E:/slice/mcp/dist/recorte-mcp.mjs"] }`.

Depois de mudar o código em `mcp/` ou em `src/editor/project.ts`, rode `npm run build:mcp` de novo.

### Segurança

- O app abre um canal só em `127.0.0.1`, numa porta aleatória.
- Cada pedido precisa de uma chave aleatória, gravada em `%LOCALAPPDATA%\dev.recorte.app\control.json`. O arquivo fica na sua pasta de usuário, fora do alcance de outros usuários do Windows.
- Pedidos de páginas da web (com cabeçalho `Origin`) são recusados.
- O arquivo é apagado quando o app fecha.

### Exemplos de pedidos

- "Transcreva a última gravação, corte as pausas maiores que 1 segundo e os 'é' e 'hã', aplique o estilo Tutorial e exporte em 1080p."
- "Desfoque o e-mail que aparece no canto superior direito entre 12 s e 20 s."
- "Faça uma versão vertical para Reels, com legendas em cima, e exporte."

## Atualizações

- O app procura versões novas no GitHub (`flackback/recorte`, aba Releases) 4 segundos depois de abrir e a cada 6 horas. No modo de desenvolvimento, só quando você pede.
- Quando há versão nova, aparece o botão azul "Atualizar para x.y.z" na barra de título. O app baixa, instala e abre de novo. Gravando ou exportando, ele pede para esperar.
- Para procurar na hora: botão direito na barra de título → "Procurar atualizações".
- As atualizações são assinadas. O app só instala um arquivo assinado com a chave do projeto.

### Publicar uma versão nova

1. Entre no GitHub uma vez: `gh auth login`.
2. Rode `.\scripts\release.ps1 -Version 0.2.0 -Notes "O que mudou"`.
3. O script muda a versão nos três arquivos, gera o instalador assinado, cria o `latest.json` e publica a release.

A chave de assinatura fica em `%USERPROFILE%\.tauri\recorte.key`, fora do projeto. Guarde uma cópia: sem ela, os apps instalados não aceitam versões novas.

## Créditos

### Slice, a inspiração

O Recorte existe por causa do **[Slice](https://github.com/rit3zh/Slice)**, criado por **[rit3zh](https://github.com/rit3zh)** para macOS. A lista de recursos do Recorte (zoom automático pelos cliques, cursor suavizado, estilos prontos, desenho durante a gravação, transcrição com cortes por palavras, entre outros) segue o que o Slice mostrou ser útil.

- O Recorte foi escrito do zero para Windows, com outras tecnologias (Tauri, WebGPU e APIs do Windows). Ele não copia código, ícones, sons nem modelos do Slice.
- O Slice é distribuído pela licença própria dele, a *Slice Source-Available License*, de rit3zh. Ela vale para o código do Slice, não para o Recorte.
- O Recorte não é afiliado ao Slice nem a rit3zh, e não tem o apoio deles. "Slice" é o nome do projeto de rit3zh e aparece aqui só para dizer de onde vem a inspiração.

Se você usa Mac, use o Slice original: https://github.com/rit3zh/Slice

### Bibliotecas e modelos

| Componente | Uso no Recorte | Licença |
|---|---|---|
| [Tauri](https://tauri.app) | Base do app (janela, comandos, atualização) | MIT ou Apache-2.0 |
| [windows-capture](https://github.com/NiiightmareXD/windows-capture) | Captura da tela e codificação H.264 | MIT |
| [windows-rs](https://github.com/microsoft/windows-rs) | APIs do Windows | MIT ou Apache-2.0 |
| [wasapi](https://github.com/HEnquist/wasapi-rs) | Áudio do sistema e microfone | MIT |
| [hound](https://github.com/ruuda/hound) | Arquivos WAV | Apache-2.0 |
| [nnnoiseless](https://github.com/jneem/nnnoiseless) (porta do [RNNoise](https://github.com/xiph/rnnoise)) | Remoção de ruído da voz | BSD-3-Clause |
| [trash](https://github.com/Byron/trash-rs) | Mover gravações para a Lixeira | MIT |
| [tiny_http](https://github.com/tiny-http/tiny-http) | Canal local do servidor MCP | MIT ou Apache-2.0 |
| [Transformers.js](https://github.com/huggingface/transformers.js) | Transcrição no próprio computador | Apache-2.0 |
| [Whisper](https://github.com/openai/whisper) (modelo `onnx-community/whisper-base_timestamped`) | Reconhecimento de fala; baixado na primeira transcrição | MIT |
| [mp4box.js](https://github.com/gpac/mp4box.js) | Leitura de MP4 na exportação | BSD-3-Clause |
| [mp4-muxer](https://github.com/Vanilagy/mp4-muxer) | Escrita do MP4 exportado | MIT |
| [gifenc](https://github.com/mattdesl/gifenc) | Exportação em GIF | MIT |
| [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) | Servidor MCP | MIT |
| [Zod](https://github.com/colinhacks/zod) | Validação das ferramentas do MCP | MIT |

## Requisitos

- Windows 10 2004 (build 19041) ou mais recente.
- Rust (toolchain MSVC), Node.js 20+, Visual Studio Build Tools com C++.
- WebView2 (já vem no Windows 10 e 11 atualizados).
- Internet só na primeira transcrição, para baixar o modelo Whisper (cerca de 80 MB, da Hugging Face). Depois fica em cache.

## Rodar

```bash
npm install
npm run tauri dev
```

Teste da captura sem a interface:

```bash
cd src-tauri
cargo run --example smoke -- C:\caminho\da\saida 5
```

Para capturas de tela ou automação da interface durante o desenvolvimento, defina `RECORTE_CAPTURABLE=1` (desliga a exclusão da janela da gravação).

## Arquivos de uma gravação (`Vídeos\Recorte\take-…`)

| Arquivo | Conteúdo |
|---|---|
| `screen.mp4` | Tela em H.264 (em gravações antigas, também o áudio do sistema em AAC) |
| `system.wav` | Áudio do sistema |
| `segments\`, `segments.json`, `recording.json`, `*.partial.jsonl` | Só durante a gravação ou depois de um travamento: segmentos e dados para recuperar |
| `mic.wav`, `mic.enhanced.wav` | Microfone original e melhorado |
| `webcam.mp4` | Webcam (MP4 fragmentado) |
| `cursor.json` | Mouse: `{t, k, b?, x, y, w?, c?}`, com `k` = m, d, u, w ou s (formato) |
| `keys.json` | Teclas: `{t, n, m}` (nome e modificadores) |
| `transcript.json` | Palavras com início e fim em ms |
| `take.json` | Metadados da gravação |
| `project.json` | A edição |
| `.mcp-history\` | Edições feitas pela IA, para `undo_last_edit` |
| `thumb.jpg` | Miniatura para a lista |

## Código

| Caminho | Papel |
|---|---|
| `src-tauri/src/recorder.rs` | Gravação, encoder, arquivos da gravação |
| `src-tauri/src/audio.rs` | Áudio do sistema e microfone |
| `src-tauri/src/cursor.rs` | Hooks de mouse e teclado, formato do cursor |
| `src-tauri/src/voice.rs` | Melhoria de voz |
| `src-tauri/src/overlay.rs` | Janela de área e de desenho, atalhos globais |
| `src-tauri/src/export.rs` | Escrita em disco de exportações e arquivos da gravação |
| `src/main.ts` | Painel de gravação, webcam, lista |
| `src/overlay-app.ts` | Página da janela de área e de desenho |
| `src/editor/editor.ts` | Editor: abas, ferramentas, reprodução, desfazer |
| `src/editor/renderer.ts` | Composição WebGPU (shader WGSL) |
| `src/editor/composition.ts` | Estado de cada quadro (prévia e exportação) |
| `src/editor/timemap.ts` | Tempo do vídeo final × tempo da gravação (cortes) |
| `src/editor/timeline.ts` | Timeline em canvas |
| `src/editor/exporter.ts` | Exportação MP4 e GIF |
| `src/editor/transcribe.ts`, `transcribe.worker.ts` | Transcrição |
| `src/editor/mp4.ts` | Leitor de MP4 por partes (índice e amostras sob demanda) |
| `src/editor/audio-source.ts` | Áudio por partes (WAV e AAC) |
| `src/join.ts` | Junta os segmentos da gravação em `screen.mp4` |
| `src/editor/cleanup.ts` | Silêncios e hesitações |
| `src/updates.ts`, `scripts/release.ps1` | Atualização automática e publicação |
| `src-tauri/src/control.rs` | Canal local para o servidor MCP |
| `src/agent.ts` | Atende os pedidos da IA no app: recarregar, abrir, exportar, transcrever |
| `mcp/server.ts`, `mcp/store.ts`, `mcp/app.ts` | Servidor MCP: ferramentas, arquivos das gravações, conversa com o app |

## Limitações conhecidas

- **iPhone:** não grava iPhone conectado; o Windows não tem um caminho confiável para isso.
- **Molduras:** são desenhadas em 2D (janela e notebook), sem os modelos 3D do Slice.
- **Borda amarela:** no Windows 10 aparece em volta da tela durante a gravação (aviso de captura do sistema); o Windows 11 permite escondê-la.
- **Janela movida:** na gravação de janela, a área é lida só no início.
- **Desenhos da gravação:** entram fixos no vídeo; ainda não dá para editá-los depois no editor (os textos, setas e destaques do editor dão).
