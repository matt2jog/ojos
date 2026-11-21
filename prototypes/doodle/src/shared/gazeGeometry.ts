import type { ViewportRect } from './capture'

/** The pane uses normalized display units. Max boxes use encoded pixels. */
export function paneGazeIoU(pane: ViewportRect, box: ViewportRect, width: number, height: number): number {
  if (width <= 0 || height <= 0 || box.w <= 0 || box.h <= 0 || pane.w <= 0 || pane.h <= 0) return 0
  const gaze = {
    x: (box.x + box.w * 0.125) / width,
    y: (box.y + box.h * 0.125) / height,
    w: box.w * 0.75 / width,
    h: box.h * 0.75 / height
  }
  const x = Math.max(0, Math.min(pane.x + pane.w, gaze.x + gaze.w) - Math.max(pane.x, gaze.x))
  const y = Math.max(0, Math.min(pane.y + pane.h, gaze.y + gaze.h) - Math.max(pane.y, gaze.y))
  const intersection = x * y
  return intersection / (pane.w * pane.h + gaze.w * gaze.h - intersection)
}
