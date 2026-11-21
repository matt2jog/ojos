import type { NativeImage } from 'electron'

const COLUMNS = 64
const ROWS = 40
const WINDOW_MS = 12_000
const MAX_FRAMES = 18
const MAX_FRAME_BYTES = 900_000

type Region = { x: number; y: number; width: number; height: number }
type Frame = { at: number; pixels: Buffer; jpeg: Buffer }

export type EvidenceFrame = {
  id: string
  ageMs: number
  region: Region | null
  readCrop: () => string
}

function sample(image: NativeImage): Buffer {
  return image.resize({ width: COLUMNS, height: ROWS, quality: 'good' }).toBitmap({ scaleFactor: 1 })
}

/** Bound changed thumbnail pixels and leave a margin for surrounding text. */
function changedRegion(earlier: Buffer, current: Buffer): Region | null {
  if (earlier.length !== COLUMNS * ROWS * 4 || earlier.length !== current.length) return null
  let count = 0
  let left = COLUMNS
  let top = ROWS
  let right = 0
  let bottom = 0
  for (let i = 0; i < COLUMNS * ROWS; i++) {
    const p = i * 4
    const difference = Math.max(
      Math.abs(earlier[p] - current[p]),
      Math.abs(earlier[p + 1] - current[p + 1]),
      Math.abs(earlier[p + 2] - current[p + 2])
    )
    if (difference < 35) continue
    const x = i % COLUMNS
    const y = Math.floor(i / COLUMNS)
    count++
    left = Math.min(left, x)
    top = Math.min(top, y)
    right = Math.max(right, x)
    bottom = Math.max(bottom, y)
  }
  if (count < 5) return null
  left = Math.max(0, left - 3)
  top = Math.max(0, top - 3)
  right = Math.min(COLUMNS, right + 4)
  bottom = Math.min(ROWS, bottom + 4)
  return { x: left / COLUMNS, y: top / ROWS, width: (right - left) / COLUMNS, height: (bottom - top) / ROWS }
}

function crop(decode: (data: Buffer) => NativeImage, jpeg: Buffer, region: Region): string {
  const image = decode(jpeg)
  const { width, height } = image.getSize()
  const x = Math.floor(region.x * width)
  const y = Math.floor(region.y * height)
  const right = Math.min(width, Math.ceil((region.x + region.width) * width))
  const bottom = Math.min(height, Math.ceil((region.y + region.height) * height))
  return image.crop({ x, y, width: right - x, height: bottom - y }).toJPEG(88).toString('base64')
}

function overlaps(a: Region, b: Region): boolean {
  const width = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
  const height = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))
  const intersection = width * height
  return intersection / (a.width * a.height + b.width * b.height - intersection) >= 0.7
}

/** One opted-in display, memory only. Compare against the actual current screenshot. */
export class ScreenHistory {
  private frames: Frame[] = []
  private readonly decode: (data: Buffer) => NativeImage

  constructor(decode: (data: Buffer) => NativeImage) {
    this.decode = decode
  }

  clear(): void {
    this.frames = []
  }

  private prune(now: number): void {
    this.frames = this.frames.filter(frame => now - frame.at <= WINDOW_MS)
  }

  remember(image: NativeImage, at: number): void {
    this.prune(at)
    const pixels = sample(image)
    const previous = this.frames.at(-1)
    if (previous && !changedRegion(previous.pixels, pixels)) return
    let jpeg = image.toJPEG(87)
    if (jpeg.length > MAX_FRAME_BYTES) jpeg = image.toJPEG(68)
    if (jpeg.length > MAX_FRAME_BYTES) return
    this.frames.push({ at, pixels, jpeg })
    if (this.frames.length > MAX_FRAMES) this.frames.shift()
  }

  evidence(current: NativeImage, observedAt: number, now: number): EvidenceFrame[] {
    this.prune(now)
    const pixels = sample(current)
    const candidates: { frame: Frame; region: Region }[] = []
    for (const frame of [...this.frames].reverse()) {
      if (frame.at > observedAt - 350) continue
      const region = changedRegion(frame.pixels, pixels)
      if (!region || candidates.some(candidate => overlaps(candidate.region, region))) continue
      candidates.push({ frame, region })
    }
    // Keep the latest distinct region and the largest earlier changes. Repeated
    // motion in a small video inset cannot fill every candidate.
    const [latest, ...older] = candidates
    if (!latest) return []
    older.sort((a, b) => b.region.width * b.region.height - a.region.width * a.region.height)
    return [latest, ...older.slice(0, 2)].sort((a, b) => b.frame.at - a.frame.at)
      .map(({ frame, region }, index) => ({
        id: 'frame-' + (index + 1),
        ageMs: Math.round(observedAt - frame.at),
        region,
        readCrop: () => crop(this.decode, frame.jpeg, region)
      }))
  }
}
