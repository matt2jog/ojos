// Canvas doodle engine. Plain imperative code on purpose: the 60fps pen animation runs
// outside React. React only mounts the canvas and feeds commands in.
import type { Cmd, DrawCmd, Point } from '../../../shared/commands'

const COLORS: Record<string, string> = { red: '#ea4335', blue: '#4285f4', green: '#34a853', yellow: '#fbbc05' }
const col = (c?: string): string => (c && COLORS[c]) || c || COLORS.red
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const jitter = (n: number): number => (Math.random() - 0.5) * n

export interface EngineHooks {
  title(text: string): void
  /** Show a sentence (typed out). Resolve when done. */
  say(text: string, isCurrent: () => boolean): Promise<void>
}

export class DoodleEngine {
  private ctx: CanvasRenderingContext2D
  private queue: Cmd[] = []
  private busy = false
  private gen = 0

  constructor(
    private canvas: HTMLCanvasElement,
    private hooks: EngineHooks
  ) {
    this.ctx = canvas.getContext('2d')!
    this.fit()
  }

  fit(): void {
    const dpr = window.devicePixelRatio || 1
    this.canvas.width = innerWidth * dpr
    this.canvas.height = innerHeight * dpr
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }

  push(cmd: Cmd): void {
    this.queue.push(cmd)
    void this.pump()
  }

  /** Cancel everything in flight and wipe the canvas. */
  reset(): void {
    this.gen++
    this.queue = []
    this.busy = false
    this.ctx.clearRect(0, 0, innerWidth, innerHeight)
  }

  /** Cancel in-flight work but leave the canvas (for fade-outs). */
  cancel(): void {
    this.gen++
    this.queue = []
    this.busy = false
  }

  private async pump(): Promise<void> {
    if (this.busy) return
    this.busy = true
    const myGen = this.gen
    const isCurrent = (): boolean => myGen === this.gen
    while (this.queue.length && isCurrent()) {
      const cmd = this.queue.shift()!
      if ('title' in cmd) this.hooks.title(cmd.title)
      else if ('say' in cmd) await this.hooks.say(cmd.say, isCurrent)
      else if ('draw' in cmd) await this.draw(cmd, isCurrent)
    }
    if (isCurrent()) this.busy = false
  }

  // ---- geometry ----
  private px([x, y]: Point): Point {
    return [(x / 1000) * innerWidth, (y / 1000) * innerHeight]
  }

  private circlePts(box: [number, number, number, number]): Point[] {
    const [x1, y1] = this.px([box[0], box[1]])
    const [x2, y2] = this.px([box[2], box[3]])
    const cx = (x1 + x2) / 2
    const cy = (y1 + y2) / 2
    const rx = Math.abs(x2 - x1) / 2 + 14
    const ry = Math.abs(y2 - y1) / 2 + 12
    const start = -Math.PI / 2 - 0.6 + jitter(0.6)
    const sweep = Math.PI * 2 + 0.45 // overshoot like a real hand
    const w1 = Math.random() * 6
    const w2 = Math.random() * 6
    const pts: Point[] = []
    for (let i = 0; i <= 90; i++) {
      const t = i / 90
      const a = start + sweep * t
      const wob = 1 + 0.035 * Math.sin(a * 2 + w1) + 0.02 * Math.sin(a * 3 + w2) + t * 0.05
      pts.push([cx + Math.cos(a) * rx * wob, cy + Math.sin(a) * ry * wob])
    }
    return pts
  }

  private linePts(from: Point, to: Point, bend = 0): Point[] {
    const [ax, ay] = this.px(from)
    const [bx, by] = this.px(to)
    const cx = (ax + bx) / 2 - (by - ay) * bend
    const cy = (ay + by) / 2 + (bx - ax) * bend
    const pts: Point[] = []
    for (let i = 0; i <= 40; i++) {
      const t = i / 40
      const u = 1 - t
      pts.push([
        u * u * ax + 2 * u * t * cx + t * t * bx + jitter(1),
        u * u * ay + 2 * u * t * cy + t * t * by + jitter(1)
      ])
    }
    return pts
  }

  private arrowHeads(pts: Point[]): Point[][] {
    const [bx, by] = pts[pts.length - 1]
    const [ax, ay] = pts[pts.length - 6]
    const ang = Math.atan2(by - ay, bx - ax)
    const L = 18
    return [-1, 1].map((s) => {
      const a = ang + Math.PI + s * 0.5
      return [
        [bx, by],
        [bx + Math.cos(a) * L * 0.5, by + Math.sin(a) * L * 0.5],
        [bx + Math.cos(a) * L, by + Math.sin(a) * L]
      ] as Point[]
    })
  }

  // ---- animated pen ----
  private stroke(pts: Point[], color: string, width: number, ms: number, isCurrent: () => boolean, alpha = 1): Promise<void> {
    const ctx = this.ctx
    ctx.save()
    ctx.strokeStyle = color
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.globalAlpha = alpha
    const t0 = performance.now()
    let drawn = 1
    return new Promise<void>((done) => {
      const frame = (now: number): void => {
        if (!isCurrent()) return done()
        const target = Math.min(pts.length, Math.ceil(((now - t0) / ms) * pts.length) + 1)
        for (; drawn < target; drawn++) {
          const t = drawn / pts.length
          ctx.lineWidth = width * (0.55 + 0.45 * Math.sin(Math.PI * Math.min(1, t * 1.15))) // pressure taper
          ctx.beginPath()
          ctx.moveTo(...pts[drawn - 1])
          ctx.lineTo(...pts[drawn])
          ctx.stroke()
        }
        if (drawn < pts.length) requestAnimationFrame(frame)
        else done()
      }
      requestAnimationFrame(frame)
    }).finally(() => ctx.restore())
  }

  private async draw(cmd: DrawCmd, isCurrent: () => boolean): Promise<void> {
    const c = col(cmd.color)
    switch (cmd.draw) {
      case 'circle':
        return this.stroke(this.circlePts(cmd.box), c, 4.5, 650, isCurrent)
      case 'underline':
        return this.stroke(this.linePts(cmd.from, cmd.to, 0.03), c, 4.5, 400, isCurrent)
      case 'arrow': {
        const pts = this.linePts(cmd.from, cmd.to, 0.18)
        await this.stroke(pts, c, 4.5, 500, isCurrent)
        for (const h of this.arrowHeads(pts)) await this.stroke(h, c, 4.5, 90, isCurrent)
        return
      }
      case 'highlight': {
        const [x1, y1] = this.px([cmd.box[0], cmd.box[1]])
        const [x2, y2] = this.px([cmd.box[2], cmd.box[3]])
        const h = Math.max(14, Math.abs(y2 - y1) + 6)
        const y = (y1 + y2) / 2
        const pts: Point[] = []
        for (let i = 0; i <= 30; i++) pts.push([x1 + ((x2 - x1) * i) / 30, y + jitter(1.5)])
        this.ctx.save()
        this.ctx.globalCompositeOperation = 'multiply'
        await this.stroke(pts, col(cmd.color || 'yellow'), h, 450, isCurrent, 0.35)
        this.ctx.restore()
        return
      }
      case 'label': {
        const ctx = this.ctx
        const [x, y] = this.px(cmd.at)
        ctx.save()
        ctx.fillStyle = c
        ctx.font = "600 30px Caveat, 'Bradley Hand', 'Segoe Print', cursive"
        ctx.shadowColor = 'rgba(255,255,255,.9)'
        ctx.shadowBlur = 6
        let cx = x
        for (const ch of cmd.text ?? '') {
          if (!isCurrent()) break
          ctx.fillText(ch, cx, y + jitter(1.5))
          cx += ctx.measureText(ch).width
          await sleep(45)
        }
        ctx.restore()
        return
      }
    }
  }
}
