export class Draft {
  constructor(
    readonly author: string,
    readonly body: string,
  ) {}

  toHtml(): string {
    return `<article><h3>${this.author}</h3><p>${this.body}</p></article>`
  }
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}
