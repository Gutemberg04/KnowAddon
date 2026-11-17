'use strict'

/**
 * Descoberta de qualidade dos players HLS do site.
 *
 * O site rotula o player como "FHD" independentemente do arquivo entregue.
 * Para não prometer uma qualidade que o vídeo não tem, lemos o playlist:
 *  - se for um master (`#EXT-X-STREAM-INF`), usamos as variantes declaradas;
 *  - se for playlist de mídia, baixamos só o começo do primeiro segmento e
 *    extraímos a resolução real do SPS do H.264.
 */

const config = require('./config')

const SEGMENT_PROBE_BYTES = 192 * 1024
const PROBE_TIMEOUT_MS = 8000

const H264_PROFILES = [100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]

async function probeHls(playlistUrl) {
  const response = await fetch(playlistUrl, {
    redirect: 'follow',
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    headers: {
      'user-agent': config.USER_AGENT,
      referer: `${config.SITE_URL}/`,
      accept: '*/*'
    }
  })

  if (!response.ok) throw new Error(`HTTP ${response.status} no playlist`)

  const playlist = await response.text()
  const variants = parseVariants(playlist, playlistUrl)

  if (variants.length > 1) {
    return { variants }
  }

  if (variants.length === 1 && variants[0].height) {
    return { variants: [], width: variants[0].width, height: variants[0].height }
  }

  const segmentUrl = firstSegmentUrl(playlist, playlistUrl)
  if (!segmentUrl) return null

  const segment = await fetch(
    segmentUrl,
    {
      redirect: 'follow',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      headers: {
        'user-agent': config.USER_AGENT,
        referer: `${config.SITE_URL}/`,
        accept: '*/*',
        range: `bytes=0-${SEGMENT_PROBE_BYTES - 1}`
      }
    }
  )

  if (!segment.ok) throw new Error(`HTTP ${segment.status} no segmento`)

  const buffer = Buffer.from(await segment.arrayBuffer())
  const size = resolutionFromTs(buffer)
  return size || null
}

function parseVariants(playlist, playlistUrl) {
  const lines = playlist.split(/\r?\n/)
  const variants = []
  let attrs = null

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue

    if (/^#EXT-X-STREAM-INF:/i.test(line)) {
      attrs = line.slice(line.indexOf(':') + 1)
      continue
    }

    if (line.startsWith('#')) continue
    if (!attrs) continue

    const resolution = attrs.match(/RESOLUTION=(\d+)x(\d+)/i)
    const bandwidth = attrs.match(/BANDWIDTH=(\d+)/i)
    variants.push({
      url: new URL(line, playlistUrl).href,
      width: resolution ? Number(resolution[1]) : 0,
      height: resolution ? Number(resolution[2]) : 0,
      bandwidth: bandwidth ? Number(bandwidth[1]) : 0
    })
    attrs = null
  }

  return variants.sort(
    (a, b) => b.height - a.height || b.bandwidth - a.bandwidth
  )
}

function firstSegmentUrl(playlist, playlistUrl) {
  for (const rawLine of playlist.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    try {
      return new URL(line, playlistUrl).href
    } catch {
      return null
    }
  }
  return null
}

/** Lê a resolução do H.264 dentro de um segmento MPEG-TS. */
function resolutionFromTs(buffer) {
  const spsPositions = findSps(buffer)

  for (const position of spsPositions.slice(0, 10)) {
    try {
      const size = parseSpsSize(buffer.slice(position, position + 200))
      if (size && size.width >= 128 && size.height >= 128) return size
    } catch {
      // SPS cortado pelo cabeçalho do TS: tenta o próximo
    }
  }

  return null
}

function findSps(buffer) {
  const positions = []

  for (let i = 0; i + 4 < buffer.length; i++) {
    if (buffer[i] !== 0 || buffer[i + 1] !== 0) continue

    const startCodeLength =
      buffer[i + 2] === 1 ? 3 : buffer[i + 2] === 0 && buffer[i + 3] === 1 ? 4 : 0

    if (!startCodeLength) continue

    const nalStart = i + startCodeLength
    if ((buffer[nalStart] & 0x1f) === 7) positions.push(nalStart)
  }

  return positions
}

function parseSpsSize(nalWithHeader) {
  const data = removeEmulationPrevention(nalWithHeader.slice(1))
  const reader = bitReader(data)

  const profile = reader.readBits(8)
  reader.readBits(8) // constraint flags
  reader.readBits(8) // level
  reader.readUE() // seq_parameter_set_id

  let chromaFormat = 1
  if (H264_PROFILES.includes(profile)) {
    chromaFormat = reader.readUE()
    if (chromaFormat === 3) reader.readBits(1)
    reader.readUE() // bit_depth_luma_minus8
    reader.readUE() // bit_depth_chroma_minus8
    reader.readBits(1) // qpprime_y_zero_transform_bypass_flag
    if (reader.readBits(1)) return null // scaling matrix: não suportado
  }

  reader.readUE() // log2_max_frame_num_minus4

  const picOrderCntType = reader.readUE()
  if (picOrderCntType === 0) {
    reader.readUE()
  } else if (picOrderCntType === 1) {
    reader.readBits(1)
    reader.readSE()
    reader.readSE()
    const count = reader.readUE()
    for (let i = 0; i < count; i++) reader.readSE()
  }

  reader.readUE() // max_num_ref_frames
  reader.readBits(1) // gaps_in_frame_num_value_allowed_flag

  const widthInMbs = reader.readUE() + 1
  const heightInMapUnits = reader.readUE() + 1
  const frameMbsOnly = reader.readBits(1)
  if (!frameMbsOnly) reader.readBits(1)
  reader.readBits(1) // direct_8x8_inference_flag

  let cropLeft = 0
  let cropRight = 0
  let cropTop = 0
  let cropBottom = 0

  if (reader.readBits(1)) {
    cropLeft = reader.readUE()
    cropRight = reader.readUE()
    cropTop = reader.readUE()
    cropBottom = reader.readUE()
  }

  const cropUnitX = chromaFormat === 1 || chromaFormat === 2 ? 2 : 1
  const cropUnitY = (chromaFormat === 1 ? 2 : 1) * (2 - frameMbsOnly)

  return {
    width: widthInMbs * 16 - (cropLeft + cropRight) * cropUnitX,
    height: (2 - frameMbsOnly) * heightInMapUnits * 16 - (cropTop + cropBottom) * cropUnitY
  }
}

function removeEmulationPrevention(nal) {
  const output = []
  let zeros = 0

  for (const byte of nal) {
    if (zeros >= 2 && byte === 3) {
      zeros = 0
      continue
    }
    output.push(byte)
    zeros = byte === 0 ? zeros + 1 : 0
  }

  return Buffer.from(output)
}

function bitReader(data) {
  let bitPosition = 0

  return {
    readBits(count) {
      let value = 0
      for (let i = 0; i < count; i++) {
        const byte = data[bitPosition >> 3]
        if (byte === undefined) throw new Error('fim dos dados')
        value = (value << 1) | ((byte >> (7 - (bitPosition & 7))) & 1)
        bitPosition++
      }
      return value
    },
    readUE() {
      let zeros = 0
      while (this.readBits(1) === 0) {
        zeros++
        if (zeros > 31) throw new Error('exp-golomb inválido')
      }
      if (zeros === 0) return 0
      return (1 << zeros) - 1 + this.readBits(zeros)
    },
    readSE() {
      const value = this.readUE()
      return value & 1 ? (value + 1) >> 1 : -(value >> 1)
    }
  }
}

module.exports = { probeHls, resolutionFromTs }
