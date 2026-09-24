import type { Language } from './analyzer'

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

/**
 * The Python seed. Same obligation as the TypeScript one above — every rule the binder implements
 * shows up somewhere — and the comments name the cases a reader arriving from TypeScript gets
 * wrong: `if` is not a scope, a comprehension is, and a class body is invisible from inside a
 * method.
 */
export const PYTHON_SAMPLE = `# Move the cursor, or click a node in the tree on the right.
# The editor underlines where the thing under your cursor was defined.

# An imported name resolves to its import statement; 'defined in' says
# which tab holds the real declaration.
from format import format_address
import defaults

greeting = "hello"

config = {"host": "localhost", "port": 8080, "retries": 3}


# The 'greeting' below resolves to this parameter, not the module-level
# name above: a name that enters scope as a parameter is defined by it.
def greet(greeting, target):
    return f"{greeting}, {target}"


# Tuple unpacking: each name is defined by its own element, with the
# whole assignment dimmed underneath.
host, port = config["host"], config["port"]


# An assignment anywhere in a function makes the name local throughout —
# so 'total' here is this function's, not any module-level one.
def summarise(rows):
    total = 0
    for row in rows:              # 'row' is defined by the for target
        total += row
    # A comprehension has a scope of its own: 'r' does not leak out.
    doubled = [r * 2 for r in rows]
    if total:
        # 'if' is NOT a scope: 'label' is visible after this block.
        label = "some"
    else:
        label = "none"
    return label, total, doubled


class Connection:
    # A class body is invisible from inside a method — 'scheme' below
    # resolves here only through 'self'.
    scheme = "tcp"

    def __init__(self, host, port):
        self.host = host
        self.port = port

    def describe(self):
        return f"{self.scheme}://{self.host}:{self.port}"


def main():
    connection = Connection(host, port or defaults.PORT)
    with open("hosts.txt") as handle:      # 'handle' is defined by the with
        first = handle.readline()
    try:
        address = format_address(host, port)
    except ValueError as error:            # 'error' is defined by the except
        address = str(error)
    return [greet(greeting, address), connection.describe(), first, config["retries"]]
`

/** The seed for a language. Only a link asking for Python gets the Python one — the default buffer
 *  is still the TypeScript sample every embed and every test is written against. */
export function sampleFor(language: Language): string {
  return language === 'py' ? PYTHON_SAMPLE : SAMPLE
}
