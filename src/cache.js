'use strict'

/**
 * Cache em memória com TTL. Simples e suficiente para um addon pessoal:
 * evita bater no site a cada navegação no Stremio.
 */

const store = new Map()
const MAX_ENTRIES = 400

function get(key) {
  const entry = store.get(key)
  if (!entry) return undefined
  if (Date.now() > entry.expiresAt) {
    store.delete(key)
    return undefined
  }
  return entry.value
}

function set(key, value, ttlMs) {
  if (store.size >= MAX_ENTRIES) {
    // Remove as entradas mais antigas (Map preserva ordem de inserção)
    const oldest = store.keys().next().value
    if (oldest !== undefined) store.delete(oldest)
  }
  store.set(key, { value, expiresAt: Date.now() + ttlMs })
  return value
}

/**
 * Retorna o valor do cache ou executa `producer` e guarda o resultado.
 * Também compartilha a mesma Promise entre chamadas concorrentes.
 */
const inflight = new Map()

async function wrap(key, ttlMs, producer) {
  const cached = get(key)
  if (cached !== undefined) return cached

  if (inflight.has(key)) return inflight.get(key)

  const promise = (async () => {
    try {
      const value = await producer()
      set(key, value, ttlMs)
      return value
    } finally {
      inflight.delete(key)
    }
  })()

  inflight.set(key, promise)
  return promise
}

module.exports = { get, set, wrap }
