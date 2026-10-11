import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react'
import { stepCritical } from '../uikit/spring'

/**
 * The motion shared by the panels that open under the top bar: Help and
 * Notifications. Both read it from here so they cannot drift apart.
 *
 * Progress runs 0 to 1 on the critically damped spring in `uikit/spring.ts`
 * at its default response, from the value already on screen, so a second
 * click reverses it mid-flight. The panel fades in while it settles 6px down
 * and grows from 98% to full size around its top right corner (the panel sets
 * `transform-origin: top right`). Reduced motion keeps the fade only.
 */
export function panelMotionStyle(progress: number, reduced: boolean): CSSProperties {
  return reduced
    ? { opacity: progress }
    : {
        opacity: progress,
        transform: `translateY(${(-6 * (1 - progress)).toFixed(2)}px) scale(${(0.98 + 0.02 * progress).toFixed(4)})`,
      }
}

export function useReducedMotion(): boolean {
  const [on, setOn] = useState(() => reducedNow())
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const apply = () => setOn(mq.matches)
    apply()
    mq.addEventListener?.('change', apply)
    return () => mq.removeEventListener?.('change', apply)
  }, [])
  return on
}

function reducedNow(): boolean {
  return typeof window !== 'undefined'
    && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
}

/**
 * Runs the panel's spring on the element itself and says whether to render it.
 *
 * DO NOT move the progress back into state. It was state, and every frame of
 * the 300ms open re-rendered the whole panel - the help index, the notification
 * list - sixty times a second, which is the stutter on the click that opens
 * it. The spring writes opacity and transform straight to `panel`; React hears
 * about the panel twice, when it appears and when it has gone.
 *
 * A new target keeps the current velocity, so a second click reverses it
 * mid-flight. Leave opacity and transform out of the panel's JSX style.
 */
export function usePanelMotion(
  open: boolean,
  panel: RefObject<HTMLElement | null>,
  reduced: boolean,
): boolean {
  const [present, setPresent] = useState(open)
  const live = useRef({ value: 0, velocity: 0 })
  const frame = useRef(0)

  if (open && !present) setPresent(true)

  useLayoutEffect(() => {
    const el = panel.current
    if (!el) return
    cancelAnimationFrame(frame.current)
    const target = open ? 1 : 0
    const paint = (value: number) => {
      const style = panelMotionStyle(value, reduced)
      el.style.opacity = String(style.opacity)
      el.style.transform = typeof style.transform === 'string' ? style.transform : ''
    }
    const settle = () => {
      live.current = { value: target, velocity: 0 }
      paint(target)
      if (!open) setPresent(false)
    }
    if (reduced || (live.current.value === target && live.current.velocity === 0)) {
      settle()
      return
    }
    paint(live.current.value)
    let last = performance.now()
    const started = last
    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      const next = stepCritical(live.current.value, live.current.velocity, target, dt)
      live.current = next
      const settled = Math.abs(next.value - target) < 0.001 && Math.abs(next.velocity) < 0.01
      if (settled || now - started > 1200) {
        settle()
        return
      }
      paint(next.value)
      frame.current = requestAnimationFrame(tick)
    }
    frame.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame.current)
  }, [open, present, reduced, panel])

  return open || present
}
