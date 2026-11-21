import { useEffect, useRef, type RefObject } from 'react'
import { DoodleEngine, type EngineHooks } from '../doodle/engine'

interface Props {
  hooks: EngineHooks
  /** Filled with the live engine once mounted, so the parent can push commands. */
  engineRef: RefObject<DoodleEngine | null>
}

/** Full-screen canvas that owns a DoodleEngine. The pen animation runs outside React. */
export function DoodleCanvas({ hooks, engineRef }: Props): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const hooksRef = useRef(hooks)
  hooksRef.current = hooks

  useEffect(() => {
    // Hooks are read through a ref so the engine always calls the latest callbacks.
    const engine = new DoodleEngine(canvasRef.current!, {
      title: (t) => hooksRef.current.title(t),
      say: (t, cur) => hooksRef.current.say(t, cur)
    })
    engineRef.current = engine
    const onResize = (): void => engine.fit()
    addEventListener('resize', onResize)
    return () => {
      removeEventListener('resize', onResize)
      engine.reset()
      engineRef.current = null
    }
  }, [engineRef])

  return <canvas ref={canvasRef} className="doodle-canvas" />
}
