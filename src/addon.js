'use strict'

const { addonBuilder } = require('stremio-addon-sdk')

const config = require('./config')
const scraper = require('./scraper')
const pkg = require('../package.json')

function isSeriesType(type) {
  return type === 'series' || type === 'tv'
}

const manifest = {
  id: 'org.animesdigital.stremio',
  version: pkg.version,
  name: 'Animes Digital',
  description:
    'Assista aos animes, doramas e filmes do Animes Digital (animesdigital.org) direto no Stremio. ' +
    'Catálogo com os últimos títulos, busca e players em HLS/MP4. Addon não oficial, sem vínculo com o site.',
  logo: `${config.PUBLIC_URL}/logo.svg`,
  // "tv" é o tipo que alguns clientes (Nuvio) usam para séries. Declaramos os
  // dois para que o addon nunca seja filtrado na hora de buscar as fontes.
  types: ['series', 'tv'],
  resources: [
    { name: 'catalog', types: ['series', 'tv'] },
    { name: 'meta', types: ['series', 'tv'] },
    { name: 'stream', types: ['series', 'tv'] }
  ],
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
  if (!isSeriesType(type)) return { metas: [] }

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
  if (!isSeriesType(type) || !id.startsWith('ad:anime:')) return { meta: null }

  // Alguns clientes acrescentam "temporada:episódio" ao id do anime.
  const slug = id.slice('ad:anime:'.length).replace(/:\d+:\d+$/, '')

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

/**
 * Alguns clientes (Nuvio, forks do Stremio) montam o id do conteúdo de formas
 * diferentes da que declaramos no meta, por exemplo:
 *   ad:ep:139556:1:1    (id do vídeo + temporada + episódio)
 *   ad:anime:slug:1:3   (id do anime + temporada + episódio)
 * Aceitamos essas variações para não devolver "nenhuma fonte" só por causa
 * do formato do id.
 */
function parseStreamId(rawId) {
  const id = String(rawId || '').trim()
  if (!id) return null

  const animeWithEpisode = id.match(/^ad:anime:(.+?):(\d+):(\d+)$/i)
  if (animeWithEpisode) {
    return {
      kind: 'anime',
      slug: animeWithEpisode[1],
      season: Number(animeWithEpisode[2]),
      episode: Number(animeWithEpisode[3])
    }
  }

  if (id.startsWith('ad:anime:')) {
    return { kind: 'anime', slug: id.slice('ad:anime:'.length) }
  }

  if (id.startsWith('ad:ep:')) {
    const videoId = id.slice('ad:ep:'.length).replace(/:\d+:\d+$/, '')
    return videoId ? { kind: 'episode', videoId } : null
  }

  return null
}

async function streamsForAnimeId(target) {
  const meta = await scraper.getMeta(target.slug)
  if (!meta || !Array.isArray(meta.videos) || !meta.videos.length) return []

  const video = target.season
    ? meta.videos.find(
        (item) => item.season === target.season && item.episode === target.episode
      )
    : meta.videos[0]

  if (!video || typeof video.id !== 'string') return []

  return scraper.getStreams(video.id.slice('ad:ep:'.length))
}

builder.defineStreamHandler(async ({ type, id }) => {
  if (!isSeriesType(type)) return { streams: [] }

  const target = parseStreamId(id)
  if (!target) return { streams: [] }

  try {
    if (target.kind === 'episode') {
      return { streams: await scraper.getStreams(target.videoId) }
    }

    return { streams: await streamsForAnimeId(target) }
  } catch (error) {
    console.error(`[animesdigital] erro nos streams "${id}":`, error.message)
    return { streams: [] }
  }
})

module.exports = builder.getInterface()
module.exports.manifest = manifest
