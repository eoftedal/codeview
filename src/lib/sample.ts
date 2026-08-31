/** Seed buffer: every definition rule the tool implements shows up somewhere below. */
export const SAMPLE = `// Move the cursor, or click a node in the tree on the right.
// The editor underlines where the thing under your cursor was defined.

// An imported name resolves to its import statement: the declaration
// itself lives in another file, which this single-buffer view can't see.
import { formatAddress } from './format'
import defaults from './defaults'

const greeting = 'hello'

const config = {
  host: 'localhost',
  port: 8080,
  retries: 3,
}

// The 'greeting' below resolves to this parameter, not the const above:
// a name that enters scope as a parameter is defined by that parameter.
function greet(greeting: string, target: { name: string }) {
  return \`\${greeting}, \${target.name}\`
}

// Destructuring: 'host' is defined by its binding element, and the
// declaration it was pulled out of is dimmed underneath.
const { host, port } = config

class Connection {
  constructor(
    private readonly host: string,
    private readonly port: number,
  ) {}

  describe(): string {
    return \`\${this.host}:\${this.port}\`
  }
}

const connect = (settings = config) => new Connection(settings.host, settings.port)

export function main() {
  const connection = connect()
  const address = formatAddress(host, port ?? defaults.port)

  // 'config.retries' highlights the property, with the object creation dimmed.
  return [greet(greeting, { name: address }), connection.describe(), config.retries]
}
`
