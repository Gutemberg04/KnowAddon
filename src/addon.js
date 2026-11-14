'use strict'

const { addonBuilder } = require('stremio-addon-sdk')

const config = require('./config')
const scraper = require('./scraper')
const pkg = require('../package.json')

const manifest = {
  id: 'org.animesdigital.stremio',
  version: pkg.version,
  name: 'Animes Digital',
  description:
    'Assista aos animes, doramas e filmes do Animes Digital (animesdigital.org) direto no Stremio. ' +
    'Catálogo com os últimos títulos, busca e players em HLS/MP4. Addon não oficial, sem vínculo com o site.',
  logo: `${config.PUBLIC_URL}/logo.svg`,
  types: ['series'],
  resources: ['catalog', 'meta', 'stream'],
  idPrefixes: ['ad:'],
  catalogs: [
    {
      type: 'series',
      id: 'latest',
      name: 'Últimos Animes',
      extra: [{ name: 'skip', isRequired: false }]
    },
    {
      type: 'series',
      id: 'search',
      name: 'Buscar Animes',
      extra: [{ name: 'search', isRequired: true }]
    }
  ],
  behaviorHints: {
    adult: false
  }
}

const builder = new addonBuilder(manifest)

// ---------------------------------------------------------------------------
// Catálogo
// ---------------------------------------------------------------------------

builder.defineCatalogHandler(async ({ type, id, extra = {} }) => {
  if (type !== 'series') return { metas: [] }

  const skip = Math.max(0, Number(extra.skip) || 0)

  try {
    if (id === 'latest') {
      return { metas: await scraper.getLatest(skip) }
    }

    if (id === 'search') {
      const term = String(extra.search || '').trim()
      if (!term) return { metas: [] }
      return { metas: await scraper.search(term, skip) }
    }

    return { metas: [] }
  } catch (error) {
    console.error(`[animesdigital] erro no catálogo "${id}":`, error.message)
    return { metas: [] }
  }
})

// ---------------------------------------------------------------------------
// Meta
// ---------------------------------------------------------------------------

builder.defineMetaHandler(async ({ type, id }) => {
  if (type !== 'series' || !id.startsWith('ad:anime:')) return { meta: null }

  const slug = id.slice('ad:anime:'.length)

  try {
    return { meta: await scraper.getMeta(slug) }
  } catch (error) {
    console.error(`[animesdigital] erro no meta "${slug}":`, error.message)
    return { meta: null }
  }
})

// ---------------------------------------------------------------------------
// Streams
// ---------------------------------------------------------------------------

builder.defineStreamHandler(async ({ type, id }) => {
  if (type !== 'series' || !id.startsWith('ad:ep:')) return { streams: [] }

  const videoId = id.slice('ad:ep:'.length)

  try {
    return { streams: await scraper.getStreams(videoId) }
  } catch (error) {
    console.error(`[animesdigital] erro nos streams "${videoId}":`, error.message)
    return { streams: [] }
  }
})

module.exports = builder.getInterface()
module.exports.manifest = manifest
