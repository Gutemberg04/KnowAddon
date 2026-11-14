'use strict'

const path = require('path')
const fs = require('fs')
const { Readable } = require('stream')

const express = require('express')
const { getRouter } = require('stremio-addon-sdk')

const config = require('./config')
const addonInterface = require('./addon')

const app = express()
app.disable('x-powered-by')
app.set('trust proxy', true)

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

      <p>Se o botão não abrir o app, copie a URL do manifest e cole em
        <strong>Addons → Instalar via URL</strong>:</p>
      <p><code>${escapeHtml(manifestUrl)}</code></p>

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
