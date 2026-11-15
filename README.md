# Animes Digital — Addon para Stremio

Addon **não oficial** para o [Stremio](https://www.stremio.com/) que usa o
[animesdigital.org](https://animesdigital.org) como fonte de catálogo e players.
Também aceita requisições do **Nuvio**, que usa o tipo `tv` para séries.

Desenvolvido com o [Stremio Addon SDK](https://github.com/Stremio/stremio-addon-sdk)
(`stremio-addon-sdk`) + Express + Cheerio.

---

## Recursos

- **Catálogo "Últimos Animes"** — lista os títulos recém-adicionados no site, com paginação.
- **Busca integrada** — pesquise direto na aba Explorar do Stremio.
- **Ficha completa** — pôster, sinopse, ano, gêneros e lista de episódios
  (inclusive séries longas com centenas de episódios, que o site pagina).
- **Streams**:
  - **Player FHD (HLS)** — playlist `.m3u8` direta do CDN usado pelo site.
  - **Player 2 (MP4)** — resolução automática dos vídeos do Blogger
    (720p/360p).
  - Fallback para abrir o player no navegador quando nada é resolvido.
- **Cache em memória** para reduzir requisições ao site e acelerar a navegação.

> O addon apenas lê páginas públicas do site. Não hospeda, armazena nem
> redistribui vídeos.

---

## Requisitos

- **Node.js 20 ou superior** (recomendado: 22 LTS ou mais recente)
- Stremio **Desktop** (Windows/macOS/Linux) para instalação local via HTTP.
  O Stremio Web exige HTTPS e pode bloquear addons em `localhost`.

---

## Rodando localmente

```bash
npm install
npm start
```

> **Windows / PowerShell:** se aparecer um erro de política de execução
> (`npm.ps1 não pode ser carregado`), use `npm.cmd start` ou execute
> diretamente `node src/server.js`. Para instalar dependências, use
> `npm.cmd install`.

O addon sobe em `http://127.0.0.1:7000`.

> Se o botão **Instalar no Stremio** não abrir o app (alguns navegadores
> bloqueiam o protocolo `stremio://`), use o campo **“URL do addon”** na
> página inicial e clique em **Copiar URL**. Depois, no Stremio, vá em
> **Addons → Instalar via URL** e cole.

Abra **http://127.0.0.1:7000** no navegador e clique em **“Instalar no Stremio”**.
Se preferir, copie a URL e instale manualmente em
**Addons → Instalar via URL**:

```
http://127.0.0.1:7000/manifest.json
```

Ou use o link direto:

```
stremio://127.0.0.1:7000/manifest.json
```

### Teste rápido (sem abrir o Stremio)

```bash
npm run smoke
```

O script testa catálogo, busca, ficha do anime e resolução de streams
usando a rede de verdade.

---

## Variáveis de ambiente

| Variável        | Padrão                       | Descrição |
| --------------- | ---------------------------- | --------- |
| `PORT`          | `7000`                       | Porta do servidor. |
| `PUBLIC_URL`    | `http://127.0.0.1:<PORT>`    | URL pública usada no manifest (logo) e no proxy. **Defina em produção.** |
| `PROXY_STREAMS` | `false`                      | Se `true`, os MP4 do Blogger passam por `/proxy`. Necessário quando o addon roda em servidor remoto (veja abaixo). |

Exemplo:

```bash
PORT=7000 PUBLIC_URL=https://meu-addon.exemplo.com npm start
```

No Windows (PowerShell):

```powershell
$env:PUBLIC_URL="https://meu-addon.exemplo.com"
$env:PORT="7000"
npm start
```

---

## Publicar de graça (sem servidor próprio)

### O Git resolve isso?

O Git/GitHub serve para **guardar o código e disparar o deploy**, mas não para
executar o addon:

- **GitHub Pages** só entrega arquivos estáticos (HTML/JSON). Ele não roda o
  scraper nem responde às rotas `/catalog`, `/meta` e `/stream` em tempo real.
- **GitHub Actions** não expõe uma URL pública para o Stremio chamar.
- O addon precisa de um endereço **HTTPS** que responda a essas rotas na hora.

Ou seja: **GitHub = código-fonte + deploy automático**; quem executa é uma
plataforma gratuita (Vercel, Render ou um túnel para o seu PC).

---

### Opção 1 — Vercel (recomendada, 100% grátis)

O projeto já está preparado: `vercel.json` + `api/index.js` fazem a Vercel
executar o app Express como função serverless.

1. Crie um repositório no GitHub e envie o projeto:

   ```bash
   git init
   git add .
   git commit -m "Addon Animes Digital para Stremio"
   git branch -M main
   git remote add origin https://github.com/SEU-USUARIO/SEU-REPO.git
   git push -u origin main
   ```

2. Acesse [vercel.com](https://vercel.com), entre com o GitHub e clique em
   **Add New → Project**; importe o repositório.

3. Em **Framework Preset**, escolha **Other**. Deixe *Build Command* e
   *Output Directory* vazios.

4. Em **Environment Variables**, adicione:

   | Nome            | Valor |
   | --------------- | ----- |
   | `PUBLIC_URL`    | `https://SEU-PROJETO.vercel.app` |
   | `PROXY_STREAMS` | `true` |

5. Clique em **Deploy**. A URL do addon será:

   ```
   https://SEU-PROJETO.vercel.app/manifest.json
   ```

6. Instale no Stremio (Addons → Instalar via URL) ou abra a landing page
   `https://SEU-PROJETO.vercel.app`.

> **Importante:** `PUBLIC_URL` precisa ser o domínio final (sem barra no fim).
> Ele é usado no logo do manifest e nos links do proxy. Se trocar de domínio,
> atualize a variável e faça um novo deploy.

**Limitações da Vercel (plano Hobby):**

- Há limite de tempo por requisição (o projeto configura `maxDuration: 60`).
  As páginas do site costumam responder em poucos segundos.
- O cache em memória é por instância — não é compartilhado entre execuções.
- Os streams **HLS** funcionam normalmente. Os MP4 do Blogger podem falhar,
  porque o link do `googlevideo` fica vinculado ao IP de quem o resolveu e as
  funções serverless trocam de IP. Trate-os como fallback.

---

### Opção 2 — Render (grátis, mas hiberna)

1. Envie o projeto para o GitHub.
2. Em [render.com](https://render.com): **New → Web Service** → conecte o repo.
3. Configure:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Environment:** `PUBLIC_URL=https://SEU-APP.onrender.com` e
     `PROXY_STREAMS=true`.
4. Após o deploy, instale `https://SEU-APP.onrender.com/manifest.json`.

O plano gratuito hiberna após alguns minutos sem uso; o primeiro acesso depois
disso pode levar ~50 segundos. Para uso pessoal, é uma opção válida.

---

### Opção 3 — Cloudflare Tunnel (usa seu PC, sem criar conta)

Se você não quer publicar em nuvem, pode expor o addon que roda no seu
computador com uma URL HTTPS pública e gratuita. O PC precisa ficar ligado.

```powershell
winget install --id Cloudflare.cloudflared
cloudflared tunnel --url http://localhost:7000
```

O comando imprime uma URL parecida com:

```
https://algo-aleatorio.trycloudflare.com
```

Instale no Stremio:

```
https://algo-aleatorio.trycloudflare.com/manifest.json
```

A URL muda cada vez que o túnel é reiniciado. Para uma URL fixa seria preciso
uma conta Cloudflare com um domínio próprio. Alternativas parecidas: `ngrok`
(possui 1 domínio estático grátis, mas insere uma página de aviso) e
`localhost.run`.

---

### Outras opções gratuitas

- **Hugging Face Spaces (Docker)** — sobe o `Dockerfile` do projeto, com URL
  HTTPS pública; o Space hiberna após período de inatividade.
- **Koyeb / Fly.io** — camadas gratuitas limitadas, suficientes para uso
  pessoal.
- **VPS gratuito (Oracle Cloud Always Free)** — mais trabalhoso, mas é um
  servidor completo e com IP fixo (bom para os MP4 do Blogger).

---

## Deploy em VPS/Docker

O addon também é um servidor Node/Express comum; em uma VPS, basta:

1. Clonar o repositório.
2. `npm install` e `npm start` (ou usar o `Dockerfile`).
3. Definir `PUBLIC_URL` com a URL/domínio público.
4. Opcionalmente `PROXY_STREAMS=true`.
5. Instalar `https://SEU-DOMINIO/manifest.json`.

### Por que `PROXY_STREAMS=true`?

Os links de vídeo do Blogger (`googlevideo.com`) são gerados vinculados ao **IP
de quem fez a requisição**. Quando o addon roda no seu PC, esse IP é o seu — e
tudo funciona. Quando roda em um servidor, o link fica preso ao IP do servidor
e o player do Stremio (no seu PC) não consegue baixá-lo.

Com `PROXY_STREAMS=true`, o addon entrega os MP4 através de `/proxy`, que
repassa o vídeo (inclusive `Range`, necessário para avançar/retroceder) usando
o IP do servidor. Os streams HLS (`m3u8`) continuam diretos.

### Docker

```bash
docker build -t animes-digital-addon .
docker run --rm -p 7000:7000 \
  -e PUBLIC_URL=http://127.0.0.1:7000 \
  animes-digital-addon
```

Em produção, troque `PUBLIC_URL` pelo domínio HTTPS e adicione
`-e PROXY_STREAMS=true`.

---

## Como funciona

```
Stremio
  │
  ├─ /catalog/series/latest.json ─────► /ultimos-titulos-adicionados/page/N/
  ├─ /catalog/series/search/...  ─────► /pesquisa/<termo>/page/N/
  ├─ /meta/series/ad:anime:<slug>.json ► /anime/a/<slug> (+ /page/N/)
  └─ /stream/series/ad:ep:<id>.json ──► /video/a/<id>/
                                           ├─ iframe api.anivideo.net?d=<m3u8> → stream HLS
                                           └─ iframe animesdigital.org/<base64> → Blogger → MP4
```

### Identificadores

- Anime: `ad:anime:<slug>` (ex.: `ad:anime:black-clover-2-2`)
- Episódio: `ad:ep:<id-do-video>` (ex.: `ad:ep:139630`)

O prefixo `ad:` está declarado em `idPrefixes` no manifest.

### Estrutura de arquivos

```
src/
  addon.js    # manifest + handlers (catálogo, meta, stream)
  server.js   # Express, landing page, proxy e rotas do SDK
  scraper.js  # parsing do site e resolução de players
  cache.js    # cache em memória com TTL
  config.js   # configuração central
test/smoke.js # teste de fumaça
public/logo.svg
```

---

## Limitações e solução de problemas

- **Site fora do ar ou com layout novo** — o parser pode precisar de ajuste.
  Rode `npm run smoke` para ver em qual etapa falhou.
- **“Nenhum stream disponível”** — o episódio pode ter só players embedados de
  terceiros; nesse caso o addon oferece “Abrir player externo”.
- **MP4 não abre em servidor remoto** — habilite `PROXY_STREAMS=true`.
- **Stremio Web não instala** — use o Stremio Desktop ou um deploy HTTPS.
- **Porta ocupada** — rode com `PORT=7001 npm start` e reinstale o addon com a
  nova porta.
- **Cloudflare / bloqueio de datacenter** — alguns provedores podem ser
  bloqueados pelo site. Teste o deploy antes de divulgar.

### Nuvio: addon instala, mas não mostra fontes

1. **Abra o anime pelo catálogo do addon** (“Últimos Animes” ou a busca do
   addon). O addon só responde aos IDs `ad:…`; títulos abertos pelos catálogos
   padrão do Nuvio (TMDB/IMDb) usam outro ID e não encontram fontes.
2. **Confira o servidor pelo próprio celular**, na mesma rede do Nuvio:
   `https://SEU-DOMINIO/debug/stream/139556` (troque o número por um episódio
   seu). Se aparecer `"count": 3`, o addon está entregando as fontes e o
   problema está no app.
3. **Compare com o Stremio** usando a mesma URL. Se funcionar no Stremio, é
   problema do Nuvio — versões **beta 0.6.x** têm um bug conhecido em que
   nenhum addon retorna streams (`NuvioMedia/NuvioMobile#2442`). Teste a
   versão estável.
4. **Veja o que o app está pedindo**: no painel da Vercel, em
   *Deployments → Functions → Logs*, cada requisição aparece como
   `GET /stream/series/ad:ep:139556.json -> 200`. Se não aparecer nenhuma
   requisição de `/stream/...`, o app nem chegou a consultar o addon.

O addon aceita IDs em vários formatos (`ad:ep:123`, `ad:ep:123:1:1`,
`ad:anime:slug:1:1`) e os tipos `series` e `tv`, justamente para cobrir as
variações entre clientes.

---

## Aviso legal

Este projeto é independente e **não possui vínculo** com o animesdigital.org
nem com o Stremio. Todo o conteúdo é disponibilizado por terceiros; o addon
somente interpreta as páginas públicas do site. Utilize apenas para fins
pessoais e respeite as leis de direitos autorais do seu país.
