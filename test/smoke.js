'use strict'

/**
 * Teste rápido de fumaça (usa a rede de verdade).
 * Uso: npm run smoke
 */

const scraper = require('../src/scraper')

async function main() {
  console.log('1) Catálogo "Últimos Animes"...')
  const latest = await scraper.getLatest(0)
  console.log(`   ${latest.length} itens. Primeiros:`, latest.slice(0, 3).map((m) => m.name))
  if (!latest.length) throw new Error('Catálogo vazio')

  console.log('\n2) Busca por "black clover"...')
  const results = await scraper.search('black clover', 0)
  console.log(`   ${results.length} itens:`, results.slice(0, 5).map((m) => m.name))
  if (!results.length) throw new Error('Busca vazia')

  const target = results[0]
  const slug = target.id.replace('ad:anime:', '')
  console.log(`\n3) Meta de "${target.name}" (${slug})...`)
  const meta = await scraper.getMeta(slug)
  console.log(`   ${meta.name} • ${meta.videos.length} episódios • ano ${meta.releaseInfo || '?'}`)
  if (!meta.videos.length) throw new Error('Nenhum episódio encontrado')

  const episode = meta.videos[meta.videos.length - 1]
  const videoId = episode.id.replace('ad:ep:', '')
  console.log(`\n4) Streams do episódio ${episode.episode} (${videoId})...`)
  const streams = await scraper.getStreams(videoId)
  console.log(`   ${streams.length} opções:`)
  for (const stream of streams) {
    console.log(`   - ${stream.title}`)
    console.log(`     ${stream.url || stream.externalUrl}`)
  }

  const playable = streams.filter((s) => s.url)
  if (!playable.length) throw new Error('Nenhum stream reproduzível encontrado')

  console.log('\nOK — tudo funcionando.')
}

main().catch((error) => {
  console.error('\nFALHOU:', error.message)
  process.exit(1)
})
