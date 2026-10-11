import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

import { usePanelMotion, useReducedMotion } from './panelMotion'
import './accountmenu.css'

export interface AccountMenuItem {
  key: string
  label: ReactNode
  icon?: ReactNode
  danger?: boolean
  disabled?: boolean
  disabledHint?: string
  onClick?: () => void
}

/**
 * The account card under the avatar at the right of the top bar: who is signed
 * in, what they hold, and Profile, Appearance and Sign out. No hover tooltip;
 * the avatar carries an aria-label. Opens with the Help and Notifications
 * panel motion, and behaves as a menu from the keyboard.
 */
export function AccountMenu({
  name, initials, email, roles, badge, active, items,
}: {
  name: string
  initials: string
  email?: string
  roles: string[]
  badge?: ReactNode
  active?: boolean
  items: AccountMenuItem[]
}) {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const reduced = useReducedMotion()
  const present = usePanelMotion(open, panel, reduced)
  const menuId = useId()
  const focusFirst = useRef(false)

  const enabled = () => Array.from(panel.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])') ?? [])

  const close = (refocus: boolean) => {
    setOpen(false)
    if (refocus) trigger.current?.focus()
  }

  useEffect(() => {
    if (!open) return
    if (focusFirst.current) {
      focusFirst.current = false
      requestAnimationFrame(() => enabled()[0]?.focus())
    }
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node | null
      if (!t || panel.current?.contains(t) || trigger.current?.contains(t)) return
      close(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); close(true) }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const onPanelKey = (e: React.KeyboardEvent) => {
    const list = enabled()
    if (!list.length) return
    const at = list.indexOf(document.activeElement as HTMLElement)
    const go = (i: number) => { e.preventDefault(); list[(i + list.length) % list.length]?.focus() }
    if (e.key === 'ArrowDown') go(at + 1)
    else if (e.key === 'ArrowUp') go(at < 0 ? list.length - 1 : at - 1)
    else if (e.key === 'Home') go(0)
    else if (e.key === 'End') go(list.length - 1)
    else if (e.key === 'Tab') close(false)
  }

  const regular = items.filter((i) => !i.danger)
  const danger = items.filter((i) => i.danger)

  const item = (i: AccountMenuItem) => (
    <button
      key={i.key}
      type="button"
      role="menuitem"
      tabIndex={-1}
      className={`am-item${i.danger ? ' is-danger' : ''}`}
      aria-disabled={i.disabled || undefined}
      title={i.disabled ? i.disabledHint : undefined}
      onClick={() => {
        if (i.disabled) return
        close(false)
        i.onClick?.()
      }}
    >
      {i.icon && <span className="am-item-icon" aria-hidden>{i.icon}</span>}
      <span>{i.label}</span>
    </button>
  )

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={`ui-topbar-profile${active || open ? ' is-active' : ''}`}
        aria-label={`Account menu for ${name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if ((e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') && !open) {
            e.preventDefault()
            focusFirst.current = true
            setOpen(true)
          }
        }}
      >
        <span className="ui-nav-avatar-slot">
          <span className="ui-topbar-avatar">{initials}</span>
          {badge && <span className="ui-nav-avatar-badge" aria-hidden>{badge}</span>}
        </span>
      </button>
      {present && createPortal(
        <div
          ref={panel}
          id={menuId}
          className="am-panel"
          role="menu"
          aria-label="Account"
          aria-hidden={open ? undefined : true}
          style={{ pointerEvents: open ? undefined : 'none' }}
          onKeyDown={onPanelKey}
        >
          <div className="am-head">
            <span className="ui-topbar-avatar am-avatar" aria-hidden>{initials}</span>
            <div className="am-who">
              <div className="am-name" title={name}>{name}</div>
              {email && <div className="am-email" title={email}>{email}</div>}
              {roles.length > 0 && (
                <div className="am-roles">
                  {roles.slice(0, 2).map((r) => <span key={r} className="am-role">{r}</span>)}
                  {roles.length > 2 && (
                    <span className="am-role is-more" title={roles.slice(2).join(', ')}>{`+${roles.length - 2}`}</span>
                  )}
                </div>
              )}
            </div>
          </div>
          <div className="am-sep" role="separator" />
          <div className="am-group">{regular.map(item)}</div>
          {danger.length > 0 && (
            <>
              <div className="am-sep" role="separator" />
              <div className="am-group">{danger.map(item)}</div>
            </>
          )}
        </div>,
        document.body,
      )}
    </>
  )
}
