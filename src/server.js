'use strict'

const path = require('path')
const fs = require('fs')
const { Readable } = require('stream')

const express = require('express')
const { getRouter } = require('stremio-addon-sdk')

const config = require('./config')
const addonInterface = require('./addon')
const scraper = require('./scraper')

const app = express()
app.disable('x-powered-by')
app.set('trust proxy', true)

// Log de requisições: no Vercel aparece em Deployments → Functions → Logs.
// Serve para conferir exatamente quais caminhos o Stremio/Nuvio estão pedindo.
app.use((req, res, next) => {
  const startedAt = Date.now()
  res.on('finish', () => {
    if (req.path === '/logo.svg' || req.path === '/health') return
    const ua = String(req.get('user-agent') || '').slice(0, 70)
    console.log(
      `[animesdigital] ${req.method} ${req.originalUrl} -> ${res.statusCode} ` +
        `(${Date.now() - startedAt}ms) ua="${ua}"`
    )
  })
  next()
})

// ---------------------------------------------------------------------------
// Proxy opcional (útil quando o addon roda em um servidor remoto)
// ---------------------------------------------------------------------------

const ALLOWED_PROXY_HOSTS = [
  /(^|\.)googlevideo\.com$/i,
  /(^|\.)mywallpaper-4k-image\.net$/i,
  /(^|\.)animesdigital\.org$/i,
  /(^|\.)blogger\.com$/i,
  /(^|\.)blogspot\.com$/i,
  /(^|\.)anivideo\.net$/i
]

function isProxyAllowed(url) {
  if (!/^https?:$/i.test(url.protocol)) return false
  return ALLOWED_PROXY_HOSTS.some((pattern) => pattern.test(url.hostname))
}

app.options('/proxy', (req, res) => {
  res.setHeader('access-control-allow-origin', '*')
  res.setHeader('access-control-allow-headers', 'range,content-type')
  res.setHeader('access-control-allow-methods', 'GET,HEAD,OPTIONS')
  res.status(204).end()
})

app.get('/proxy', async (req, res) => {
  const raw = typeof req.query.url === 'string' ? req.query.url : ''
  if (!raw) return res.status(400).send('Parâmetro "url" ausente')

  let target
  try {
    target = new URL(raw)
  } catch {
    return res.status(400).send('URL inválida')
  }

  if (!isProxyAllowed(target)) return res.status(403).send('Host não permitido')

  try {
    const headers = {
      'user-agent': config.USER_AGENT,
      accept: '*/*'
    }
    if (req.headers.range) headers.range = req.headers.range

    const upstream = await fetch(target, {
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(60000)
    })

    res.status(upstream.status)
    res.setHeader('access-control-allow-origin', '*')

    for (const header of [
      'content-type',
      'content-length',
      'content-range',
      'accept-ranges',
      'etag',
      'last-modified'
    ]) {
      const value = upstream.headers.get(header)
      if (value) res.setHeader(header, value)
    }

    if (req.method === 'HEAD' || !upstream.body) return res.end()

    Readable.fromWeb(upstream.body)
      .on('error', () => res.destroy())
      .pipe(res)
  } catch (error) {
    console.error('[animesdigital] erro no proxy:', error.message)
    if (!res.headersSent) res.status(502).send('Falha ao acessar a origem')
    else res.destroy()
  }
})

// ---------------------------------------------------------------------------
// Arquivos estáticos / saúde
// ---------------------------------------------------------------------------

// Lê o logo em tempo de carga; se o arquivo não existir (ex.: bundle
// serverless), usa um SVG mínimo embutido para o manifest nunca ficar quebrado.
let logoSvg = ''
try {
  logoSvg = fs.readFileSync(path.join(__dirname, '..', 'public', 'logo.svg'), 'utf8')
} catch {
  logoSvg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">' +
    '<rect width="128" height="128" rx="28" fill="#4c8dff"/>' +
    '<path d="M52 40l36 24-36 24z" fill="#fff"/></svg>'
}

app.get('/logo.svg', (req, res) => {
  res.setHeader('content-type', 'image/svg+xml; charset=utf-8')
  res.setHeader('cache-control', 'public, max-age=86400')
  res.end(logoSvg)
})

app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '1d' }))

app.get('/health', (req, res) => {
  res.json({ status: 'ok', addon: addonInterface.manifest.name, version: addonInterface.manifest.version })
})

// Diagnóstico rápido: resolve as fontes de um episódio e mostra o resultado.
// Ex.: /debug/stream/139556
app.get('/debug/stream/:videoId', async (req, res) => {
  const startedAt = Date.now()
  const videoId = String(req.params.videoId || '').trim()

  try {
    const streams = await scraper.getStreams(videoId)
    res.setHeader('cache-control', 'no-store')
    res.json({
      ok: true,
      videoId,
      elapsedMs: Date.now() - startedAt,
      count: streams.length,
      streams
    })
  } catch (error) {
    res.status(500).json({
      ok: false,
      videoId,
      elapsedMs: Date.now() - startedAt,
      error: error.message
    })
  }
})

// ---------------------------------------------------------------------------
// Landing page com botão de instalação
// ---------------------------------------------------------------------------

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

app.get('/', (req, res) => {
  const host = req.get('host') || `127.0.0.1:${config.PORT}`
  const manifestUrl = `${req.protocol}://${host}/manifest.json`
  const stremioUrl = `stremio://${host}/manifest.json`
  const { name, description, version } = addonInterface.manifest

  res.setHeader('content-type', 'text/html; charset=utf-8')
  res.end(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(name)} — Addon para Stremio</title>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0; min-height: 100vh; display: grid; place-items: center;
      background: radial-gradient(circle at 20% 0%, #1f2a44 0%, #0b0f19 55%, #05070c 100%);
      color: #eef2f8; font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
      padding: 32px;
    }
    main { width: min(760px, 100%); }
    .card {
      background: rgba(16, 22, 36, 0.88); border: 1px solid rgba(120, 160, 255, 0.18);
      border-radius: 20px; padding: 40px; box-shadow: 0 24px 70px rgba(0, 0, 0, 0.45);
      backdrop-filter: blur(10px);
    }
    .brand { display: flex; align-items: center; gap: 16px; margin-bottom: 22px; }
    .brand img { width: 58px; height: 58px; }
    h1 { margin: 0; font-size: clamp(1.6rem, 4vw, 2.15rem); letter-spacing: -0.02em; }
    .tag { display: inline-block; margin-top: 6px; font-size: 0.78rem; color: #9fb4d8; }
    p { line-height: 1.65; color: #c5d2e8; }
    .actions { display: flex; flex-wrap: wrap; gap: 12px; margin: 28px 0 22px; }
    .btn {
      display: inline-flex; align-items: center; gap: 10px; padding: 13px 22px; border-radius: 12px;
      font-weight: 700; text-decoration: none; transition: transform .15s ease, box-shadow .15s ease;
    }
    .btn:hover { transform: translateY(-1px); }
    .btn-primary { background: linear-gradient(135deg, #7b5cff, #4c8dff); color: #fff; box-shadow: 0 10px 28px rgba(86, 108, 255, .35); }
    .btn-ghost { background: rgba(255, 255, 255, .06); border: 1px solid rgba(255, 255, 255, .14); color: #dce6f8; }
    code {
      background: rgba(255, 255, 255, .07); border: 1px solid rgba(255, 255, 255, .09);
      padding: 3px 7px; border-radius: 6px; font-size: .86em; word-break: break-all;
    }
    .copybox {
      margin: 24px 0 6px; padding: 18px; border-radius: 14px;
      border: 1px solid rgba(120, 160, 255, .18); background: rgba(255, 255, 255, .03);
    }
    .copybox label {
      display: block; margin-bottom: 10px; font-size: .78rem; letter-spacing: .08em;
      text-transform: uppercase; color: #9fb4d8;
    }
    .copyrow { display: flex; flex-wrap: wrap; gap: 10px; }
    .copyrow input {
      flex: 1 1 320px; min-width: 0; padding: 12px 14px; border-radius: 10px; font: inherit;
      font-size: .9rem; color: #eef2f8; background: rgba(0, 0, 0, .35);
      border: 1px solid rgba(255, 255, 255, .14);
    }
    .copyrow input:focus { outline: 2px solid #4c8dff; outline-offset: 1px; }
    .btn-copy {
      padding: 12px 18px; border: 0; border-radius: 10px; cursor: pointer; font: inherit;
      font-weight: 700; color: #0b0f19; background: #eef2f8;
    }
    .btn-copy:hover { background: #fff; }
    .status { min-height: 1.3em; margin: 10px 0 0; font-size: .82rem; color: #8fe3b0; }
    .steps { margin: 18px 0 0; padding-left: 22px; color: #c5d2e8; line-height: 1.8; }
    .steps strong { color: #eef2f8; }
    ul { color: #c5d2e8; line-height: 1.8; padding-left: 20px; }
    .note { margin-top: 24px; font-size: .84rem; color: #8ea3c4; border-top: 1px solid rgba(255,255,255,.08); padding-top: 18px; }
    .note a { color: #9db8ff; }
  </style>
</head>
<body>
  <main>
    <div class="card">
      <div class="brand">
        <img src="/logo.svg" alt="" onerror="this.style.display='none'" />
        <div>
          <h1>${escapeHtml(name)}</h1>
          <span class="tag">Addon não oficial • v${escapeHtml(version)}</span>
        </div>
      </div>

      <p>${escapeHtml(description)}</p>

      <div class="actions">
        <a class="btn btn-primary" href="${escapeHtml(stremioUrl)}">▶ Instalar no Stremio</a>
        <a class="btn btn-ghost" href="/manifest.json" target="_blank" rel="noreferrer">Ver manifest</a>
      </div>

      <div class="copybox">
        <label for="manifest-url">URL do addon — copie e cole no Stremio</label>
        <div class="copyrow">
          <input id="manifest-url" type="text" readonly spellcheck="false"
                 value="${escapeHtml(manifestUrl)}" />
          <button id="copy-btn" class="btn-copy" type="button">Copiar URL</button>
        </div>
        <p class="status" id="copy-status" role="status" aria-live="polite"></p>
      </div>

      <ol class="steps">
        <li>Abra o <strong>Stremio</strong> e entre em <strong>Addons</strong>.</li>
        <li>Clique em <strong>Instalar via URL</strong> (Install from URL).</li>
        <li>Cole a URL acima e confirme.</li>
      </ol>

      <ul>
        <li>Catálogo com os últimos animes adicionados</li>
        <li>Busca integrada na aba Explorar do Stremio</li>
        <li>Episódios em HLS (Player FHD) e MP4 (Player 2)</li>
      </ul>

      <div class="note">
        Conteúdo hospedado por terceiros. Este addon apenas lê o catálogo público do
        <a href="https://animesdigital.org" target="_blank" rel="noreferrer">animesdigital.org</a>.
      </div>
    </div>
  </main>

  <script>
    (function () {
      var input = document.getElementById('manifest-url')
      var button = document.getElementById('copy-btn')
      var status = document.getElementById('copy-status')

      function fallbackCopy() {
        try {
          input.focus()
          input.select()
          input.setSelectionRange(0, input.value.length)
          return document.execCommand('copy')
        } catch (error) {
          return false
        }
      }

      async function copy() {
        var text = input.value
        var copied = false

        try {
          if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(text)
            copied = true
          }
        } catch (error) {
          copied = false
        }

        if (!copied) copied = fallbackCopy()

        if (copied) {
          status.textContent = 'URL copiada! Cole no Stremio em Addons → Instalar via URL.'
          button.textContent = 'Copiado!'
          setTimeout(function () { button.textContent = 'Copiar URL' }, 2500)
        } else {
          status.textContent = 'Não foi possível copiar automaticamente. Selecione o texto e use Ctrl+C.'
        }
      }

      button.addEventListener('click', copy)

      input.addEventListener('focus', function () {
        input.select()
      })

      input.addEventListener('click', function () {
        input.select()
      })
    })()
  </script>
</body>
</html>`)
})

// ---------------------------------------------------------------------------
// Rotas do Stremio (manifest, catalog, meta, stream)
// ---------------------------------------------------------------------------

app.use(getRouter(addonInterface))

// No Vercel (api/index.js) o app é exportado e a plataforma cuida do listen.
if (require.main === module) {
  app.listen(config.PORT, () => {
    console.log('')
    console.log('  Animes Digital — addon para Stremio')
    console.log(`  Landing page: ${config.PUBLIC_URL}`)
    console.log(`  Manifest:     ${config.PUBLIC_URL}/manifest.json`)
    console.log(`  Instalar:     stremio://${config.PUBLIC_URL.replace(/^https?:\/\//, '')}/manifest.json`)
    console.log('')
  })
}

module.exports = app
