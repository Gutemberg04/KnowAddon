'use strict'

/**
 * Resolvedor de IDs "de fora" para o catálogo do Animes Digital.
 *
 * O addon só publica catálogo com IDs próprios (`ad:anime:<slug>`), mas o
 * Nuvio/Stremio consulta o addon também para títulos abertos em catálogos de
 * terceiros (TMDB, IMDb, listas de outros addons). Nesses casos o ID que chega
 * aqui é algo como:
 *
 *   tt2560140            (filme ou série do IMDb)
 *   tt2560140:4:5        (série + temporada + episódio)
 *   kitsu:7442
 *   anilist:16498
 *   mal:16498
 *
 * Para responder com fontes, é preciso transformar esse ID no slug do site:
 *   1. descobre o nome do título (Cinemeta para IMDb; Kitsu/AniList/MAL para
 *      IDs de anime);
 *   2. procura esse nome no animesdigital.org;
 *   3. escolhe o resultado mais parecido (levando temporada em conta);
 *   4. acha o episódio pedido na ficha do anime.
 *
 * Tudo é cacheado: o mapeamento de um título é resolvido uma única vez.
 */

const config = require('./config')
const scraper = require('./scraper')
const cache = require('./cache')

const JSON_HEADERS = {
  'user-agent': config.USER_AGENT,
  accept: 'application/json,text/plain;q=0.9,*/*;q=0.8',
  'accept-language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7'
}

async function fetchJson(url, options = {}) {
  const { timeout = config.EXTERNAL_TIMEOUT_MS, headers = {}, method = 'GET', body } = options

  const response = await fetch(url, {
    method,
    body,
    headers: { ...JSON_HEADERS, ...headers },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeout)
  })

  if (!response.ok) throw new Error(`HTTP ${response.status} em ${url}`)
  return response.json()
}

// ---------------------------------------------------------------------------
// Normalização e comparação de títulos
// ---------------------------------------------------------------------------

const ROMAN = { ii: '2', iii: '3', iv: '4', vi: '6', vii: '7', viii: '8', ix: '9' }

const STOPWORDS = new Set(['dublado', 'dublada', 'legendado', 'legendada', 'completo', 'completa', 'online', 'hd'])

/**
 * Deixa o título comparável: sem acento, sem pontuação, sem "dublado" etc.
 * Também troca números romanos usados como temporada ("Solo Leveling II").
 */
function normalizeTitle(value) {
  const base = String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[’'`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  return base
    .split(' ')
    .filter((token) => token && !STOPWORDS.has(token))
    .join(' ')
}

function tokensOf(value) {
  return normalizeTitle(value).split(' ').filter(Boolean)
}

/** Remove o marcador de temporada do título ("... 2 temporada", "... season 2"). */
function stripSeasonWords(value) {
  return String(value || '')
    .replace(/\b(?:season|temporada|temporadas|part|parte)\s*\d+\b/gi, ' ')
    .replace(/\b\d+\s*(?:a|ª|o|º)?\s*(?:season|temporada|temporadas)\b/gi, ' ')
    .replace(/\bfinal season\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Tenta adivinhar a temporada citada no nome ("... 2", "... II", "... Season 3"). */
function guessSeason(value, totalSeasons = null) {
  const text = normalizeTitle(value)
  if (!text) return null

  // "Final Season" normalmente é a última temporada da série.
  if (/\bfinal season\b/.test(text)) return totalSeasons || null

  const explicit =
    text.match(/\b(?:season|temporada)\s*(\d{1,2})\b/) ||
    text.match(/\b(\d{1,2})\s*(?:a|o|ª|º)?\s*(?:season|temporada)\b/)
  if (explicit) return Number(explicit[1])

  // "Shingeki no Kyojin 3 (Part 2)" -> temporada 3
  const beforePart = text.match(/\b(\d{1,2})\s*(?:part|parte)\b/)
  if (beforePart) return Number(beforePart[1])

  const tokens = tokensOf(value)
  for (let index = tokens.length - 1; index >= 1; index--) {
    const token = tokens[index]
    if (ROMAN[token]) return Number(ROMAN[token])
    if (/^\d{1,2}$/.test(token)) return Number(token)
    if (['part', 'parte', 'final', 'season', 'temporada'].includes(token)) continue
    if (!STOPWORDS.has(token)) break
  }

  return null
}

/**
 * Nota de 0 a ~115 indicando o quão parecido o resultado do site é do título
 * procurado. Abaixo de `config.MATCH_THRESHOLD` consideramos "não é o mesmo".
 */
function scoreCandidate(candidateName, variants, season, totalSeasons = null) {
  const candidate = normalizeTitle(candidateName)
  if (!candidate) return 0

  const candidateCore = normalizeTitle(stripSeasonWords(candidateName)) || candidate
  const candidateTokens = new Set(candidateCore.split(' '))
  let best = 0

  for (const variant of variants) {
    const target = normalizeTitle(variant)
    if (!target) continue

    const targetCoreTokens = new Set(tokensOf(stripSeasonWords(variant)))
    let score = 0

    if (candidateCore === target) {
      score = 100
    } else if (candidate === normalizeTitle(candidateName) && candidate === target) {
      score = 100
    } else if (candidateCore.startsWith(target + ' ') || target.startsWith(candidateCore + ' ')) {
      // Sobra de título: quanto menos palavras extras, melhor.
      const extras = Math.abs(candidateTokens.size - targetCoreTokens.size)
      score = 88 - Math.min(extras, 5) * 4
    } else {
      const intersection = [...candidateTokens].filter((token) => targetCoreTokens.has(token)).length
      const union = new Set([...candidateTokens, ...targetCoreTokens]).size
      const jaccard = union ? intersection / union : 0
      if (jaccard >= 0.66) score = 52 + jaccard * 32
      else if (jaccard >= 0.5) score = 30 + jaccard * 20
    }

    if (!score) continue

    const marker = guessSeason(candidateName, totalSeasons)
    if (season && season > 1) {
      if (marker === season) score += 20
      else if (marker && marker !== season) score -= 30
      else score -= 20
    } else if (marker && marker !== 1) {
      score -= 20
    }

    if (score > best) best = score
  }

  // Preferimos a versão dublada quando o resto empata.
  if (/dublad/i.test(candidateName)) best += 2

  return Math.max(0, Math.round(best))
}

// ---------------------------------------------------------------------------
// Fontes externas de nome (Cinemeta / Kitsu / AniList / MAL)
// ---------------------------------------------------------------------------

function imdbInfo(type, imdbId) {
  return cache.wrap(`imdb:${imdbId}`, config.CACHE_TTL.imdb, async () => {
    const kind = type === 'movie' ? 'movie' : 'series'
    const data = await fetchJson(`https://v3-cinemeta.strem.io/meta/${kind}/${imdbId}.json`)
    const meta = data && data.meta
    if (!meta || !meta.name) return null

    const videos = Array.isArray(meta.videos) ? meta.videos : []
    // A numeração absoluta considera só temporadas "de verdade" (specials,
    // que o IMDb marca como temporada 0, ficam de fora).
    const keys = videos
      .map((video) => ({
        season: Number(video.season) || 0,
        episode: Number(video.episode) || 0
      }))
      .filter((video) => video.season >= 1 && video.episode >= 1)
      .sort((a, b) => a.season - b.season || a.episode - b.episode)
      .map((video) => `${video.season}:${video.episode}`)

    return {
      name: meta.name,
      year: String(meta.releaseInfo || meta.year || '').slice(0, 4) || null,
      totalSeasons: keys.length ? Math.max(...keys.map((key) => Number(key.split(':')[0]))) : null,
      keys
    }
  }).catch((error) => {
    console.warn(`[animesdigital] Cinemeta falhou para ${imdbId}: ${error.message}`)
    return null
  })
}

async function kitsuTitles(kitsuId) {
  const data = await fetchJson(`https://kitsu.io/api/edge/anime/${encodeURIComponent(kitsuId)}`, {
    headers: { accept: 'application/vnd.api+json' }
  })
  const attributes = (data && data.data && data.data.attributes) || {}
  return Object.values(attributes.titles || {}).filter(Boolean)
}

async function kitsuSearchTitles(title) {
  return cache.wrap(`kitsu:q:${normalizeTitle(title)}`, config.CACHE_TTL.alias, async () => {
    const url =
      'https://kitsu.io/api/edge/anime?filter[text]=' +
      encodeURIComponent(title) +
      '&page[limit]=5'
    const data = await fetchJson(url, { headers: { accept: 'application/vnd.api+json' } })

    // O filtro do Kitsu é "fuzzy": devolve também sequências e títulos nada a
    // ver. Só usamos a ficha cujo nome realmente bate com o título pedido.
    const wanted = normalizeTitle(stripSeasonWords(title))
    const matches = []

    for (const item of (data && data.data) || []) {
      const attributes = item.attributes || {}
      const titles = [attributes.canonicalTitle, ...Object.values(attributes.titles || {})].filter(
        Boolean
      )

      let score = 0
      for (const candidate of titles) {
        const normalized = normalizeTitle(stripSeasonWords(candidate))
        if (!normalized) continue
        if (normalized === wanted) score = Math.max(score, 100)
        else if (normalized.startsWith(wanted + ' ') || wanted.startsWith(normalized + ' ')) {
          score = Math.max(score, 85)
        }
      }

      if (score >= 85) matches.push({ score, titles })
    }

    matches.sort((a, b) => b.score - a.score)
    return matches.length ? [...new Set(matches[0].titles)] : []
  }).catch((error) => {
    console.warn(`[animesdigital] Kitsu falhou para "${title}": ${error.message}`)
    return []
  })
}

async function anilistTitles(anilistId) {
  return cache.wrap(`anilist:${anilistId}`, config.CACHE_TTL.alias, async () => {
    const query =
      'query ($id: Int) { Media(id: $id) { title { romaji english native } synonyms } }'
    const data = await fetchJson('https://graphql.anilist.co', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ query, variables: { id: Number(anilistId) } })
    })
    const media = (data && data.data && data.data.Media) || {}
    const titles = [media.title && media.title.romaji, media.title && media.title.english]
    titles.push(...((media.synonyms || []).slice(0, 5)))
    return titles.filter(Boolean)
  }).catch(() => [])
}

async function malTitles(malId) {
  return cache.wrap(`mal:${malId}`, config.CACHE_TTL.alias, async () => {
    const data = await fetchJson(`https://api.jikan.moe/v4/anime/${encodeURIComponent(malId)}`)
    const anime = (data && data.data) || {}
    const titles = [anime.title, anime.title_english, anime.title_japanese]
    titles.push(...((anime.titles || []).map((item) => item.title)))
    return titles.filter(Boolean)
  }).catch(() => [])
}

// ---------------------------------------------------------------------------
// Busca no site
// ---------------------------------------------------------------------------

/**
 * Procura os títulos no animesdigital e devolve os candidatos ordenados por
 * semelhança. Só entram resultados acima do limite mínimo.
 */
async function matchSite(variants, season, totalSeasons = null) {
  const unique = []
  const seenTerms = new Set()

  for (const variant of variants) {
    const term = String(variant || '').trim()
    const key = normalizeTitle(term)
    if (!term || !key || seenTerms.has(key)) continue
    seenTerms.add(key)
    unique.push(term)
    if (unique.length >= 5) break
  }

  const best = new Map()
  const searches = await mapLimit(unique, 3, async (term) => {
    try {
      return { term, results: await scraper.search(term) }
    } catch (error) {
      console.warn(`[animesdigital] busca "${term}" falhou: ${error.message}`)
      return { term, results: [] }
    }
  })

  for (const { results } of searches) {
    for (const item of results) {
      const score = scoreCandidate(item.name, unique, season, totalSeasons)
      const current = best.get(item.id)
      if (!current || score > current.score) {
        best.set(item.id, { slug: item.id.slice('ad:anime:'.length), name: item.name, score })
      }
    }
  }

  return [...best.values()]
    .filter((item) => item.score >= config.MATCH_THRESHOLD)
    .sort((a, b) => b.score - a.score)
}

/** Igual ao mapLimit do scraper, mas local para não expor detalhe interno. */
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
// Resolução
// ---------------------------------------------------------------------------

/** Separa "tt123:2:5" em { imdbId, season, episode }. */
function parseImdbId(rawId) {
  const match = String(rawId || '').trim().match(/^(tt\d{5,10})(?::(\d+):(\d+))?$/i)
  if (!match) return null
  return {
    imdbId: match[1].toLowerCase(),
    season: match[2] ? Number(match[2]) : null,
    episode: match[3] ? Number(match[3]) : null
  }
}

/** "kitsu:7442:3:7" -> { provider: 'kitsu', id: '7442', season: 3, episode: 7 } */
function parsePrefixedId(rawId) {
  const match = String(rawId || '')
    .trim()
    .match(/^(kitsu|anilist|mal|myanimelist):([^:]+)(?::(\d+):(\d+))?$/i)
  if (!match) return null
  return {
    provider: match[1].toLowerCase() === 'myanimelist' ? 'mal' : match[1].toLowerCase(),
    id: match[2],
    season: match[3] ? Number(match[3]) : null,
    episode: match[4] ? Number(match[4]) : null
  }
}

/** Número absoluto do episódio (usado em animes com numeração contínua). */
function absoluteEpisode(keys, season, episode) {
  if (!Array.isArray(keys) || !keys.length || !season || !episode) return null
  const index = keys.indexOf(`${season}:${episode}`)
  return index >= 0 ? index + 1 : null
}

function pickEpisode(videos, info, season, episode) {
  if (!Array.isArray(videos) || !videos.length) return null

  const wanted = []
  if (season && episode) {
    const absolute = absoluteEpisode(info && info.keys, season, episode)
    // Em séries com várias temporadas o site costuma numerar tudo em sequência.
    if (absolute && absolute !== episode) wanted.push(absolute)
    wanted.push(episode)
    if (absolute && !wanted.includes(absolute)) wanted.push(absolute)
  } else {
    wanted.push(...videos.map((video) => video.episode))
  }

  for (const number of wanted) {
    const hit = videos.find((video) => video.episode === number)
    if (hit) return hit
  }

  return null
}

async function resolveExternal(type, rawId) {
  const id = String(rawId || '').trim()
  if (!id) return null

  const parsed = parseImdbId(id) || parsePrefixedId(id)
  if (!parsed) return null

  const { season, episode } = parsed

  return cache.wrap(`resolve:${type}:${id}`, config.CACHE_TTL.resolve, async () => {
    // 1) Nome do título
    let info = null
    let variants = []

    if (parsed.imdbId) {
      info = await imdbInfo(type, parsed.imdbId)
      if (!info) return null
      variants = [info.name]
    } else if (parsed.provider === 'kitsu') {
      variants = await kitsuTitles(parsed.id).catch(() => [])
    } else if (parsed.provider === 'anilist') {
      variants = await anilistTitles(parsed.id)
    } else if (parsed.provider === 'mal') {
      variants = await malTitles(parsed.id)
    }

    variants = [...new Set(variants.filter(Boolean))]
    if (!variants.length) return null

    // 2) Candidatos no site. Se não houver um resultado "exato", tentamos os
    //    títulos alternativos (romaji), ex.: "Attack on Titan" ->
    //    "Shingeki no Kyojin", "Demon Slayer" -> "Kimetsu no Yaiba".
    const totalSeasons = info && info.totalSeasons
    let candidates = await matchSite(variants, season, totalSeasons)

    if (!candidates.length || candidates[0].score < 100) {
      const aliases = await kitsuSearchTitles(variants[0])
      if (aliases.length) {
        const combined = [...new Set([...variants, ...aliases])]
        candidates = await matchSite(combined, season, totalSeasons)
      }
    }

    if (!candidates.length) return null

    // 3) Acha o episódio na ficha do anime. Alguns cards do site apontam para
    //    slugs que redirecionam para o vazio (ex.: "...-2-dublado"); nesses
    //    casos tentamos a versão sem o sufixo de áudio.
    for (const candidate of candidates.slice(0, 3)) {
      const slugs = [candidate.slug]
      const stripped = candidate.slug.replace(/-(dublado|legendado)$/i, '')
      if (stripped && stripped !== candidate.slug) slugs.push(stripped)

      for (const slug of slugs) {
        let meta = null
        try {
          meta = await scraper.getMeta(slug)
        } catch (error) {
          console.warn(`[animesdigital] meta "${slug}" falhou: ${error.message}`)
          continue
        }

        const video = pickEpisode(meta && meta.videos, info, season, episode)
        if (!video) continue

        return {
          slug,
          siteName: candidate.name,
          score: candidate.score,
          season,
          episode,
          siteEpisode: video.episode,
          videoId: String(video.id).replace('ad:ep:', '')
        }
      }
    }

    return null
  })
}

module.exports = {
  resolveExternal,
  // exportados para testes
  normalizeTitle,
  scoreCandidate,
  guessSeason,
  stripSeasonWords,
  parseImdbId,
  parsePrefixedId,
  pickEpisode,
  absoluteEpisode
}
