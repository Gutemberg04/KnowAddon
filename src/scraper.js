'use strict'

/**
 * Scraper do animesdigital.org
 *
 * O site é WordPress e expõe:
 *  - Últimos animes:  /ultimos-titulos-adicionados/page/N/
 *  - Busca:           /pesquisa/<termo>/page/N/
 *  - Ficha do anime:  /anime/a/<slug>  (episódios paginados em /page/N/)
 *  - Episódio:        /video/a/<id>/   (iframes de player)
 *
 * Os players normalmente entregam:
 *  - HLS direto (m3u8) via api.anivideo.net/videohls.php?d=<m3u8>
 *  - Página do Blogger (base64 no path) com MP4 do googlevideo
 */

const cheerio = require('cheerio')
const config = require('./config')
const cache = require('./cache')
const hls = require('./hls')

const BASE = config.SITE_URL

const HTML_HEADERS = {
  'user-agent': config.USER_AGENT,
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'accept-language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
  'cache-control': 'no-cache',
  pragma: 'no-cache'
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

async function fetchText(url, options = {}) {
  const { timeout = config.REQUEST_TIMEOUT_MS, headers = {}, retries = 1 } = options
  let lastError

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(timeout),
        headers: { ...HTML_HEADERS, referer: BASE + '/', ...headers }
      })

      if (!response.ok) {
        const error = new Error(`HTTP ${response.status} ao acessar ${url}`)
        error.status = response.status
        // 4xx não melhora com retry
        if (response.status >= 400 && response.status < 500) throw error
        lastError = error
        continue
      }

      return { html: await response.text(), url: response.url, status: response.status }
    } catch (error) {
      lastError = error
      if (error.status && error.status >= 400 && error.status < 500) break
    }
  }

  throw lastError || new Error(`Falha ao acessar ${url}`)
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length)
  let index = 0

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const current = index++
      results[current] = await mapper(items[current], current)
    }
  })

  await Promise.all(workers)
  return results
}

// ---------------------------------------------------------------------------
// Helpers de texto / URL
// ---------------------------------------------------------------------------

function cleanText(value) {
  return String(value || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function cleanAnimeName(raw) {
  return cleanText(raw)
    .replace(/^Assistir\s+/i, '')
    .replace(/\s+Online em HD$/i, '')
    .replace(/\s*[-–]\s*Todos os Epis[oó]dios.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Junta palavras repetidas seguidas ("... Dublado Dublado Episódio ..."). */
function collapseRepeatedWords(value) {
  return cleanText(value).replace(/\b([\p{L}\p{N}]+)(\s+\1\b)+/giu, '$1')
}

function animeSlugFromUrl(url) {
  const match = String(url || '').match(/\/anime\/a\/([^/?#]+)/i)
  return match ? decodeURIComponent(match[1]) : null
}

function videoIdFromUrl(url) {
  const match = String(url || '').match(/\/video\/a\/([^/?#]+)/i)
  return match ? decodeURIComponent(match[1]) : null
}

function parseEpisodeNumber(title) {
  const match = cleanText(title).match(/epis[oó]dio\s*(\d+(?:[.,]\d+)?)/i)
  if (!match) return null
  const number = Number(match[1].replace(',', '.'))
  return Number.isFinite(number) ? number : null
}

function absoluteUrl(url, base = BASE) {
  try {
    return new URL(url, base).href
  } catch {
    return null
  }
}

function decodeBase64Url(value) {
  try {
    const normalized = String(value).replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
    const decoded = Buffer.from(padded, 'base64').toString('utf8')
    return /^https?:\/\/[^\s]+$/i.test(decoded) ? decoded : null
  } catch {
    return null
  }
}

function decodeEmbedUrl(pathname) {
  const segments = String(pathname || '').split('/').filter(Boolean)
  for (const segment of segments) {
    if (segment.length < 24) continue
    let candidate = segment
    try {
      candidate = decodeURIComponent(segment)
    } catch {
      /* usa o valor original */
    }
    const decoded = decodeBase64Url(candidate)
    if (decoded) return decoded
  }
  return null
}

// ---------------------------------------------------------------------------
// Listagens (catálogo / busca)
// ---------------------------------------------------------------------------

/**
 * Extrai os cards de anime de uma página de listagem.
 * Funciona tanto para "últimos animes" quanto para a busca.
 */
function parseAnimeCards(html) {
  const $ = cheerio.load(html)
  const items = new Map()

  $('a[href*="/anime/a/"]').each((_, element) => {
    const href = $(element).attr('href')
    const slug = animeSlugFromUrl(href)
    if (!slug || items.has(slug)) return

    const image = $(element).find('img').first()
    const rawName =
      cleanText($(element).find('.title_anime').first().text()) ||
      cleanText($(element).attr('title')) ||
      cleanText(image.attr('alt')) ||
      slug

    items.set(slug, {
      id: `ad:anime:${slug}`,
      type: 'series',
      name: cleanAnimeName(rawName),
      poster: absoluteUrl(image.attr('src') || image.attr('data-src') || ''),
      posterShape: 'poster'
    })
  })

  return [...items.values()]
}

async function getLatest(skip = 0) {
  const page = Math.floor(skip / config.LATEST_PAGE_SIZE) + 1
  const offset = skip % config.LATEST_PAGE_SIZE

  if (page < 1 || page > 400) return []

  return cache.wrap(`latest:${page}`, config.CACHE_TTL.catalog, async () => {
    const url =
      page === 1
        ? `${BASE}/ultimos-titulos-adicionados`
        : `${BASE}/ultimos-titulos-adicionados/page/${page}/`

    const { html } = await fetchText(url)
    return parseAnimeCards(html)
  }).then((items) => items.slice(offset))
}

async function search(term, skip = 0) {
  const query = cleanText(term)
  if (!query) return []

  // A primeira página do site traz 20 resultados e as demais trazem 10.
  // Convertemos o "skip" do Stremio para a página/offset correspondentes.
  const firstSize = config.SEARCH_FIRST_PAGE_SIZE
  let page
  let offset

  if (skip < firstSize) {
    page = 1
    offset = skip
  } else {
    const rest = skip - firstSize
    page = 2 + Math.floor(rest / config.SEARCH_PAGE_SIZE)
    offset = rest % config.SEARCH_PAGE_SIZE
  }

  if (page < 1 || page > 300) return []

  const encoded = encodeURIComponent(query)
  const url = page === 1 ? `${BASE}/pesquisa/${encoded}/` : `${BASE}/pesquisa/${encoded}/page/${page}/`

  return cache.wrap(`search:${encoded}:${page}`, config.CACHE_TTL.search, async () => {
    const { html } = await fetchText(url)
    return parseAnimeCards(html)
  }).then((items) => items.slice(offset))
}

// ---------------------------------------------------------------------------
// Ficha do anime (meta)
// ---------------------------------------------------------------------------

function parseAnimeEpisodes(html) {
  const $ = cheerio.load(html)
  const episodes = []
  const seen = new Set()

  $('.lista_episodes a[href*="/video/a/"]').each((_, element) => {
    const href = $(element).attr('href')
    const videoId = videoIdFromUrl(href)
    if (!videoId || seen.has(videoId)) return
    seen.add(videoId)

    const title =
      cleanText($(element).find('.title_anime').first().text()) ||
      cleanText($(element).attr('title')) ||
      ''

    episodes.push({
      videoId,
      title,
      episode: parseEpisodeNumber(title),
      thumbnail: absoluteUrl($(element).find('img').first().attr('src') || '')
    })
  })

  return episodes
}

function parseAnimeInfo(html) {
  const $ = cheerio.load(html)

  const name =
    cleanAnimeName($('.animeInfos h1').first().text()) ||
    cleanAnimeName($('meta[property="og:title"]').attr('content') || '')

  const poster = absoluteUrl(
    $('.animeInfos .poster img').first().attr('src') ||
      $('meta[property="og:image"]').attr('content') ||
      ''
  )

  let background = poster
  const style = $('.animeInfos .cover-fundo').attr('style') || ''
  const backgroundMatch = style.match(/url\((['"]?)(.*?)\1\)/i)
  if (backgroundMatch && backgroundMatch[2]) {
    background = absoluteUrl(backgroundMatch[2]) || poster
  }

  const info = {}
  $('.animeInfos .info').each((_, element) => {
    const label = cleanText($(element).find('span').first().text())
    if (!label) return
    const value = cleanText($(element).text().replace(label, ''))
    if (value) info[label.toLowerCase()] = value
  })

  const genres = []
  $('.animeInfos .genres .genre a, .animeInfos .genres a').each((_, element) => {
    const genre = cleanText($(element).text())
    if (genre && !genres.includes(genre)) genres.push(genre)
  })

  const description =
    cleanText($('.sinopse').first().text()) ||
    cleanText($('meta[name="description"]').attr('content') || '')

  return {
    name,
    poster,
    background,
    description,
    year: info.ano || info.year || null,
    studio: info.estúdio || info.estudio || null,
    genres
  }
}

async function getMeta(slug) {
  if (!slug) return null

  return cache.wrap(`meta:${slug}`, config.CACHE_TTL.meta, async () => {
    const first = await fetchText(`${BASE}/anime/a/${encodeURIComponent(slug)}`)
    const info = parseAnimeInfo(first.html)

    // Descobre as demais páginas de episódios (séries longas são paginadas)
    const $ = cheerio.load(first.html)
    const pageUrls = new Set()

    $('.content-pagination a[href]').each((_, element) => {
      const href = $(element).attr('href')
      if (!href || !/\/page\/\d+\/?$/.test(href)) return
      const absolute = absoluteUrl(href, first.url || BASE)
      if (absolute) pageUrls.add(absolute)
    })

    const extraPages = [...pageUrls].slice(0, config.MAX_EPISODE_PAGES - 1)
    const extraHtml = await mapLimit(extraPages, 4, async (url) => {
      try {
        return (await fetchText(url)).html
      } catch (error) {
        console.warn(`[animesdigital] falha ao ler página de episódios ${url}: ${error.message}`)
        return ''
      }
    })

    const episodes = []
    const seen = new Set()
    for (const html of [first.html, ...extraHtml]) {
      if (!html) continue
      for (const episode of parseAnimeEpisodes(html)) {
        if (seen.has(episode.videoId)) continue
        seen.add(episode.videoId)
        episodes.push(episode)
      }
    }

    // Episódios sem número no título recebem número pela posição (lista vem em ordem decrescente)
    const total = episodes.length
    episodes.forEach((episode, index) => {
      if (episode.episode == null) episode.episode = total - index
    })

    episodes.sort((a, b) => a.episode - b.episode)

    const videos = episodes.map((episode) => ({
      id: `ad:ep:${episode.videoId}`,
      title: `Episódio ${episode.episode}`,
      season: 1,
      episode: episode.episode,
      thumbnail: episode.thumbnail || info.poster
    }))

    return {
      id: `ad:anime:${slug}`,
      type: 'series',
      name: info.name || slug,
      poster: info.poster || info.background,
      posterShape: 'poster',
      background: info.background || info.poster,
      description: info.description || undefined,
      releaseInfo: info.year || undefined,
      genres: info.genres.length ? info.genres : undefined,
      videos
    }
  })
}

// ---------------------------------------------------------------------------
// Players / streams
// ---------------------------------------------------------------------------

async function resolveBlogger(pageUrl, trace) {
  const note = (step, data) => {
    if (Array.isArray(trace)) trace.push({ step, ...data })
  }

  try {
    const page = await fetchText(pageUrl, { headers: { referer: BASE + '/' } })
    const tokenMatch = page.html.match(/https:\/\/www\.blogger\.com\/video\.g\?token=[^"'\s<>]+/i)
    note('blogPage', {
      url: pageUrl,
      status: page.status,
      bytes: page.html.length,
      tokenFound: Boolean(tokenMatch)
    })
    if (!tokenMatch) return []

    const tokenUrl = tokenMatch[0].replace(/&amp;/g, '&')
    const videoPage = await fetchText(tokenUrl, {
      headers: { referer: pageUrl, accept: 'text/html,*/*' }
    })
    note('tokenPage', {
      status: videoPage.status,
      bytes: videoPage.html.length
    })

    const unescaped = videoPage.html
      .replace(/\\u003d/gi, '=')
      .replace(/\\u0026/gi, '&')
      .replace(/\\u002f/gi, '/')
      .replace(/\\\//g, '/')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')

    const candidates = new Set()
    for (const match of unescaped.matchAll(/https:\/\/[^\s"'<>]+/g)) {
      const url = match[0].replace(/[\\),;]+$/, '')
      if (url.includes('googlevideo.com/videoplayback')) candidates.add(url)
    }
    note('candidates', {
      count: candidates.size,
      itags: [...candidates].map((url) => {
        try {
          return new URL(url).searchParams.get('itag')
        } catch {
          return null
        }
      })
    })

    const qualities = { 22: '720p', 18: '360p', 59: '480p', 17: '144p' }
    const heights = { 22: 720, 59: 480, 18: 360, 17: 144 }
    const byItag = new Map()

    for (const url of candidates) {
      try {
        const parsedUrl = new URL(url)
        const itag = parsedUrl.searchParams.get('itag') || ''
        const mime = parsedUrl.searchParams.get('mime') || ''
        if (mime && !mime.startsWith('video/mp4')) continue

        // A página do Blogger repete a mesma qualidade em URLs ligeiramente
        // diferentes; mantemos apenas a primeira ocorrência de cada itag.
        const key = itag || url
        if (byItag.has(key)) continue

        byItag.set(key, {
          url,
          itag,
          height: heights[itag] || 0,
          quality: qualities[itag] || (itag ? `itag ${itag}` : '')
        })
      } catch {
        /* ignora URLs inválidas */
      }
    }

    const order = { 22: 0, 59: 1, 18: 2, 17: 3 }
    const parsed = [...byItag.values()]
    parsed.sort((a, b) => (order[a.itag] ?? 99) - (order[b.itag] ?? 99))

    // Uma fonte por resolução (o Blogger repete a mesma qualidade em itags
    // diferentes em alguns vídeos). Só usa URLs sem itag quando não houver
    // nenhuma com resolução conhecida.
    const unique = []
    const seenHeights = new Set()
    for (const video of parsed.filter((v) => v.height > 0)) {
      if (seenHeights.has(video.height)) continue
      seenHeights.add(video.height)
      unique.push(video)
    }
    if (!unique.length && parsed.length) unique.push(parsed[0])

    return unique.slice(0, 3)
  } catch (error) {
    note('error', { message: error.message })
    console.warn(`[animesdigital] não foi possível resolver o player do Blogger: ${error.message}`)
    return []
  }
}

function parseEpisodePage(html) {
  const $ = cheerio.load(html)
  const title =
    collapseRepeatedWords($('#anime_title').first().text()) ||
    collapseRepeatedWords($('h1').first().text()) ||
    'Episódio'

  const iframes = new Set()
  $('#player iframe, iframe.metaframe').each((_, element) => {
    const src = $(element).attr('src') || $(element).attr('data-src')
    const absolute = absoluteUrl(src)
    if (absolute) iframes.add(absolute)
  })

  return { title, iframes: [...iframes] }
}

const HLS_INFO_TTL = 24 * 60 * 60 * 1000

/** Resolução real do HLS. Guardamos por 24h porque o arquivo não muda. */
async function hlsInfo(url) {
  try {
    return await cache.wrap(`hls:${url}`, HLS_INFO_TTL, () => hls.probeHls(url))
  } catch (error) {
    console.warn(
      `[animesdigital] não foi possível medir a qualidade do HLS: ${error.message}`
    )
    return null
  }
}

async function getStreams(videoId) {
  if (!videoId) return []

  return cache.wrap(`stream:${videoId}`, config.CACHE_TTL.stream, () =>
    buildStreams(videoId)
  )
}

/**
 * Monta as fontes de um episódio. `trace` (opcional) coleta o passo a passo
 * usado pelo diagnóstico e desliga o cache.
 */
async function buildStreams(videoId, trace) {
  const note = (step, data) => {
    if (Array.isArray(trace)) trace.push({ step, ...data })
  }

  {
    const pageUrl = `${BASE}/video/a/${encodeURIComponent(videoId)}/`
    const { html } = await fetchText(pageUrl)
    const { title, iframes } = parseEpisodePage(html)
    note('episode', { videoId, title, iframes })

    const hlsStreams = []
    const mp4Streams = []
    const fallbacks = []
    const seen = new Set()

    // Os iframes são independentes: resolvemos em paralelo para não somar o
    // tempo de cada player (era o principal motivo da demora ao abrir a lista).
    const resolved = await mapLimit(iframes, 4, async (iframe) => {
      const result = { hls: [], mp4: [], fallback: null, decoded: null, error: null }
      let parsedUrl
      try {
        parsedUrl = new URL(iframe)
      } catch {
        return result
      }

      try {
      // Player 1: HLS direto (api.anivideo.net/videohls.php?d=<m3u8>)
      if (parsedUrl.hostname.endsWith('anivideo.net') && /videohls/i.test(parsedUrl.pathname)) {
        const direct = parsedUrl.searchParams.get('d')
        let hls = direct
        try {
          hls = direct ? decodeURIComponent(direct) : direct
        } catch {
          /* mantém o valor original */
        }

        if (hls && /^https?:\/\//i.test(hls)) {
          const info = await hlsInfo(hls)

          if (info && info.variants && info.variants.length) {
            const seenHeights = new Set()

            // Master playlist: cada variante vira uma fonte com a qualidade
            // real, para o usuário escolher 1080p/720p/480p de verdade.
            for (const variant of info.variants) {
              if (!variant.height || seenHeights.has(variant.height)) continue
              seenHeights.add(variant.height)

              result.hls.push({
                name: 'OmakisAddon',
                title: `${title} • Player 1 (HLS ${variant.height}p)`,
                url: variant.url,
                __height: variant.height,
                behaviorHints: { bingeGroup: `animesdigital-hls-${variant.height}` }
              })
            }
          }

          if (!result.hls.length) {
            const height = info && info.height ? info.height : 0

            result.hls.push({
              name: 'OmakisAddon',
              title: `${title} • Player 1 (HLS${height ? ` ${height}p` : ''})`,
              url: hls,
              __height: height,
              behaviorHints: { bingeGroup: 'animesdigital-hls' }
            })
          }
        } else {
          result.fallback = iframe
        }
        return result
      }

      // Player 2: URL base64 embutida (normalmente uma página do Blogger)
      if (parsedUrl.hostname.endsWith('animesdigital.org')) {
        const decoded = decodeEmbedUrl(parsedUrl.pathname)
        result.decoded = decoded
        if (decoded) {
          if (/blogspot\.com|blogger\.com/i.test(decoded)) {
            const videos = await resolveBlogger(decoded)
            for (const video of videos) {
              const url = config.PROXY_STREAMS
                ? `${config.PUBLIC_URL}/proxy?url=${encodeURIComponent(video.url)}`
                : video.url

              result.mp4.push({
                name: 'OmakisAddon',
                title: `${title} • Player 2 (MP4${video.quality ? ` ${video.quality}` : ''})`,
                url,
                __height: video.height || 0,
                behaviorHints: {
                  bingeGroup: `animesdigital-mp4-${video.height || 'x'}`
                }
              })
            }
            if (!videos.length) result.fallback = decoded
          } else {
            result.fallback = decoded
          }
          return result
        }
      }

        result.fallback = iframe
        return result
      } catch (error) {
        result.error = error.message
        if (!result.fallback) result.fallback = iframe
        return result
      } finally {
        note('iframe', {
          iframe,
          host: parsedUrl.hostname,
          decoded: result.decoded,
          hls: result.hls.length,
          mp4: result.mp4.length,
          fallback: result.fallback,
          error: result.error
        })
      }
    })

    for (const result of resolved) {
      for (const stream of result.hls) {
        if (seen.has(stream.url)) continue
        seen.add(stream.url)
        hlsStreams.push(stream)
      }
      for (const stream of result.mp4) {
        if (seen.has(stream.url)) continue
        seen.add(stream.url)
        mp4Streams.push(stream)
      }
      if (result.fallback) fallbacks.push(result.fallback)
    }

    // Ordena da maior para a menor qualidade; em empate, HLS primeiro
    // (começa a tocar mais rápido e é o player principal do site).
    const streams = [...hlsStreams, ...mp4Streams]
      .map((stream, index) => ({ stream, index }))
      .sort(
        (a, b) =>
          (b.stream.__height || 0) - (a.stream.__height || 0) || a.index - b.index
      )
      .map(({ stream }) => {
        delete stream.__height
        return stream
      })

    // Fallback: abre o player/site no navegador
    if (!streams.length) {
      for (const url of fallbacks.slice(0, 3)) {
        streams.push({
          name: 'OmakisAddon',
          title: `${title} • Abrir player externo`,
          externalUrl: url
        })
      }
    }

    if (!streams.length) {
      streams.push({
        name: 'OmakisAddon',
        title: `${title} • Abrir episódio no site`,
        externalUrl: pageUrl
      })
    }

    return streams
  }
}

/**
 * Diagnóstico das fontes: percorre o mesmo caminho de `getStreams`, mas sem
 * cache e devolvendo o passo a passo de cada iframe.
 */
async function debugStream(videoId) {
  const trace = []
  const streams = await buildStreams(videoId, trace)
  return { streams, trace }
}

/**
 * Diagnóstico do player MP4 (Blogger): mostra cada etapa da resolução.
 * Usado por /debug/blogger/<videoId> para investigar episódios sem fontes.
 */
async function debugBlogger(videoId) {
  const pageUrl = `${BASE}/video/a/${encodeURIComponent(videoId)}/`
  const { html, status } = await fetchText(pageUrl)
  const { title, iframes } = parseEpisodePage(html)

  const trace = []
  const results = []

  for (const iframe of iframes) {
    let parsedUrl
    try {
      parsedUrl = new URL(iframe)
    } catch {
      continue
    }
    if (!parsedUrl.hostname.endsWith('animesdigital.org')) continue

    const decoded = decodeEmbedUrl(parsedUrl.pathname)
    trace.push({ step: 'decode', iframe, decoded })
    if (!decoded || !/blogspot\.com|blogger\.com/i.test(decoded)) continue

    const steps = []
    const videos = await resolveBlogger(decoded, steps)
    trace.push(...steps)
    results.push({ decoded, videos })
  }

  return { videoId, title, episodeStatus: status, iframes, trace, results }
}

module.exports = {
  getLatest,
  search,
  getMeta,
  getStreams,
  debugBlogger,
  debugStream,
  // exportados para testes
  parseAnimeCards,
  parseAnimeInfo,
  parseAnimeEpisodes,
  parseEpisodePage,
  decodeEmbedUrl,
  cleanAnimeName,
  collapseRepeatedWords
}
