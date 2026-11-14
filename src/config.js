'use strict'

/**
 * Configuração central do addon.
 * Todas as variáveis podem ser definidas por ambiente (.env é carregado
 * manualmente pelo usuário, se desejar, via `node --env-file=.env`).
 */

const PORT = Number(process.env.PORT || 7000)

// URL pública usada nos links do manifest, logo e proxy.
// Em produção (Render/Railway/VPS) defina PUBLIC_URL com o domínio real.
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://127.0.0.1:${PORT}`).replace(/\/+$/, '')

module.exports = {
  PORT,
  PUBLIC_URL,

  // Site de origem
  SITE_URL: 'https://animesdigital.org',

  // Quantidade de itens por página no site (usada para converter o "skip" do Stremio).
  // A primeira página da busca lista 20 itens; as seguintes listam 10.
  LATEST_PAGE_SIZE: 16,
  SEARCH_FIRST_PAGE_SIZE: 20,
  SEARCH_PAGE_SIZE: 10,

  // Limites de segurança
  MAX_EPISODE_PAGES: 25, // 25 páginas x ~50 episódios = até 1250 episódios
  REQUEST_TIMEOUT_MS: 20000,

  // Tempo de cache (ms)
  CACHE_TTL: {
    catalog: 5 * 60 * 1000,
    search: 10 * 60 * 1000,
    meta: 30 * 60 * 1000,
    stream: 10 * 60 * 1000
  },

  // Quando true, os MP4 do Blogger são entregues via /proxy (útil quando o
  // addon roda em servidor remoto, pois os links do googlevideo ficam presos
  // ao IP de quem os resolveu).
  PROXY_STREAMS: process.env.PROXY_STREAMS === 'true',

  USER_AGENT:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
}
