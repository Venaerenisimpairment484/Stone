import type { TextMutation } from './json-format'

const assignmentPattern = /^(\s*)(export\s+)?([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)(.*)$/

function quoteDotenv(value: string): string {
  return JSON.stringify(value)
}

export function mutateDotenv(content: string | undefined, values: Readonly<Record<string, string>>): TextMutation {
  const source = content ?? ''
  const eol = source.includes('\r\n') ? '\r\n' : '\n'
  const trailingNewline = content === undefined || /\r?\n$/.test(source)
  const lines = source === '' ? [] : source.split(/\r?\n/)
  if (lines.at(-1) === '') lines.pop()

  const found = new Set<string>()
  const nextLines = lines.map((line) => {
    const match = assignmentPattern.exec(line)
    if (!match) return line
    const [, indentation, exported = '', key, separator] = match
    if (!(key in values)) return line
    found.add(key)
    return `${indentation}${exported}${key}${separator}${quoteDotenv(values[key])}`
  })

  for (const [key, value] of Object.entries(values)) {
    if (!found.has(key)) nextLines.push(`${key}=${quoteDotenv(value)}`)
  }

  let next = nextLines.join(eol)
  if (trailingNewline && next !== '') next += eol
  return { content: next, changed: next !== content }
}
