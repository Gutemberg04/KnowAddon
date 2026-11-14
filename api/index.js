'use strict'

/**
 * Entrypoint para deploy serverless na Vercel.
 * O vercel.json reescreve todas as rotas para esta função, que exporta
 * o app Express completo (manifest, catálogo, meta, stream, proxy e landing).
 */

module.exports = require('../src/server')
