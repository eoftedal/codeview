import type { Draft } from './model'

export function renderComment(draft: Draft): void {
  const host = document.querySelector('#comments')
  if (host) host.innerHTML += draft.toHtml()
}

export function setStatus(text: string): void {
  const bar = document.querySelector('#status')
  if (bar) bar.innerHTML = '<em>' + text + '</em>'
}

export function showStatus(text: string): void {
  const bar = document.querySelector('#status')
  if (bar) bar.textContent = text
}
