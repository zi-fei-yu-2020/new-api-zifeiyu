/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/
import { useCallback, useEffect, useRef, useState } from 'react'

// A dialog is open when a Base UI popup carries data-open or a modal declares
// itself with aria-modal.
const OPEN_DIALOG =
  '[role="dialog"][data-open], [role="alertdialog"][data-open], [role="dialog"][aria-modal="true"]'

export function hasOpenDialog() {
  return document.querySelector(OPEN_DIALOG) !== null
}

export function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
}

// Backquote or Alt+B hides the game behind a plain documentation page and
// the same key brings it back (the page is a dialog, so Escape closes it too). The hook only owns the flag and
// focus: it hides the UI, never stops the run, so server sync keeps going.
// While not enabled (the tab is not visible) the keys do nothing and a hidden
// state is dropped.
export function useBossKey(props: { enabled: boolean }) {
  const [hidden, setHidden] = useState(false)
  const returnFocus = useRef<HTMLElement | null>(null)

  const hide = useCallback(() => {
    const active = document.activeElement
    returnFocus.current = active instanceof HTMLElement ? active : null
    setHidden(true)
  }, [])
  const restore = useCallback(() => {
    setHidden(false)
    // Wait one frame so the game is displayed again before focus moves back.
    requestAnimationFrame(() => {
      const target = returnFocus.current
      returnFocus.current = null
      if (target?.isConnected) target.focus({ preventScroll: true })
    })
  }, [])

  useEffect(() => {
    if (!props.enabled) return
    const keydown = (event: KeyboardEvent) => {
      const toggle =
        event.code === 'Backquote' ||
        event.key === '`' ||
        (event.altKey && event.code === 'KeyB')
      if (!toggle || event.repeat || event.ctrlKey || event.metaKey) return
      if (hidden) {
        // The only dialog open is the boss page itself.
        event.preventDefault()
        restore()
        return
      }
      if (isEditableTarget(event.target) || hasOpenDialog()) return
      event.preventDefault()
      hide()
    }
    window.addEventListener('keydown', keydown)
    return () => window.removeEventListener('keydown', keydown)
  }, [props.enabled, hidden, hide, restore])

  const [wasEnabled, setWasEnabled] = useState(props.enabled)
  if (wasEnabled !== props.enabled) {
    setWasEnabled(props.enabled)
    if (!props.enabled) setHidden(false)
  }

  return { hidden, hide, restore }
}
