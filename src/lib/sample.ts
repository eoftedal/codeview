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

/**
 * The Java seed. Same obligation as the others — every rule the binder implements shows up
 * somewhere — and the comments name the cases a reader arriving from Python or TypeScript gets
 * wrong: a block *is* a scope, a field is read without any `this.`, and overloads are separated by
 * how many arguments a call passes.
 */
export const JAVA_SAMPLE = `// Move the cursor, or click a node in the tree on the right.
// The editor underlines where the thing under your cursor was defined.

// An imported name resolves to its import statement; 'defined in' says
// which tab holds the real declaration.
import com.example.Format;

class Connection {
    // A field is read from a method by bare name, with no 'this.' —
    // the lookup walks through the class rather than skipping it.
    private final String scheme = "tcp";
    private String host;

    Connection(String host) {
        this.host = host;
    }

    // Two methods, one name: the overload is picked by how many
    // arguments the call passes, which is all a reader without types has.
    String describe() {
        return describe(0);
    }

    String describe(int port) {
        // 'host' here is the field; 'port' is the parameter above it.
        return scheme + "://" + host + ":" + port;
    }
}

class Main {
    static String greet(String greeting, String target) {
        // 'greeting' resolves to this parameter, not to any field:
        // a name that enters scope as a parameter is defined by it.
        return greeting + ", " + target;
    }

    static void main(String[] args) {
        Connection connection = new Connection("example.com");

        // A block IS a scope in Java, unlike Python: 'inner' does not
        // escape the braces it is declared in.
        if (args.length > 0) {
            String inner = args[0];
            System.out.println(inner);
        }

        for (String each : args) {          // 'each' is defined by the for
            System.out.println(each);
        }

        try (var reader = Format.open()) {  // 'reader' is defined by the try
            System.out.println(reader);
        } catch (Exception error) {         // 'error' is defined by the catch
            System.out.println(error);
        }

        System.out.println(greet("hello", connection.describe()));
    }
}
`

/**
 * C and C++ share this seed, because they share a grammar and a backend.
 *
 * It is a **memory-safety** example rather than a taint one, and that is deliberate: C has no
 * backward trace here (see src/lib/c/backend.ts on why), so a sample built around following a value
 * would advertise something the pane cannot do. What it does instead is show every definition rule
 * on code whose bug a reader can see — the length that is checked against the wrong buffer.
 */
export const C_SAMPLE = `// Move the cursor, or click a node in the tree on the right.
// The editor underlines where the thing under your cursor was defined.
//
// There is no backward trace for C — the Trace tab says so. The flows
// that matter here run through pointers, and a walk that quietly missed
// them would be worse than one that admits it cannot follow them.

#include <string.h>
#include <stdlib.h>

// A macro is a binding: click MAX_NAME below and it resolves here.
// What is NOT modelled is expansion — a name a macro *produces* exists
// nowhere in the tree, so it resolves to nothing.
#define MAX_NAME 16

// An enum's constants are written bare, so they bind in the enclosing
// scope; the dimmed header still says which enum they came from.
enum Status { STATUS_OK, STATUS_TOO_LONG };

// A typedef names the struct, and a field resolves through a receiver
// whose type is written down: try 'record.name' further down.
typedef struct Record {
    char name[MAX_NAME];
    size_t length;
} Record;

// --- the bug -------------------------------------------------------
// 'length' is the *input's* length, and it is checked against nothing.
// 'memcpy' then writes it into a 16-byte field, so any input longer
// than MAX_NAME overflows 'record->name' and whatever follows it.
enum Status store_name(Record *record, const char *input, size_t length) {
    memcpy(record->name, input, length);   // <-- unbounded write
    record->length = length;
    return STATUS_OK;
}

// What the check should have been. Note 'length' here is a different
// binding from the one above: each parameter is defined by its own
// declaration, which the underline shows.
enum Status store_name_checked(Record *record, const char *input, size_t length) {
    if (length >= MAX_NAME) {
        return STATUS_TOO_LONG;
    }
    memcpy(record->name, input, length);
    record->name[length] = '\\0';
    record->length = length;
    return STATUS_OK;
}

int main(int argc, char *argv[]) {
    // 'argv' nests inside an array-of-pointer declarator, and the name
    // sits at the bottom of that chain — which is why nothing here can
    // simply ask a declaration for its 'name'.
    if (argc < 2) {
        return 1;
    }

    Record *record = malloc(sizeof(Record));
    store_name(record, argv[1], strlen(argv[1]));

    // A block IS a scope in C: this 'record' shadows the one above and
    // does not escape the braces.
    {
        Record record = {0};
        store_name_checked(&record, argv[1], strlen(argv[1]));
    }

    free(record);

    // Use after free. 'record' still resolves to its declaration above —
    // the definition pane answers where a name comes from, not whether
    // the memory behind it is still yours.
    return (int) record->length;
}
`

/**
 * The C# seed, and the one place the samples differ in ambition: C# has a backward trace, so this
 * is built around a value worth tracing. Put the cursor on `id.Value` in `Load` and press Alt+T —
 * the walk follows the receiver back through the record, through the constructor that validates it,
 * and out to the request parameter it arrived on.
 */
export const CSHARP_SAMPLE = `// Move the cursor, or click a node in the tree on the right.
// The editor underlines where the thing under your cursor was defined.
//
// Put the cursor on 'id.Value' in Load below and press Alt+T: the trace
// follows the value back out to the request parameter it arrived on.

using System;

namespace Shop.Api;

// A positional record's components ARE its members — 'Value' below is
// generated, and it is also the canonical constructor's parameter.
// The constructor is where the value is checked, so the trace shows it.
public record ProductId(string Value)
{
    public ProductId(string value, bool validate) : this(value)
    {
        if (validate && value.Length > 64) throw new ArgumentException(nameof(value));
    }
}

public class Repository
{
    // A field's type is written down, which is what lets '_rows.Count'
    // resolve. Python's equivalent cannot, and says so.
    private readonly System.Collections.Generic.List<string> _rows = new();

    // --- the sink ---------------------------------------------------
    // 'id.Value' is read off the wrapper, and the trace follows the
    // receiver rather than the member: expanding 'Value' on its own
    // would reach every 'new ProductId(...)' in the tabs, including the
    // one in Map below that nothing ever passes to Load.
    public string Load(ProductId id)
    {
        return Query($"SELECT * FROM products WHERE id = '{id.Value}'");
    }

    // A construction the traced value never came through. Try tracing
    // from Load and check that this line does not appear.
    public ProductId Map(System.Data.IDataReader row) => new ProductId(row.GetString(0));

    private string Query(string sql) => sql;
}

// A primary constructor's parameters are in scope for the whole body.
public class Controller(Repository repository) : ControllerBase
{
    // Two methods, one name: the overload is picked by how many
    // arguments the call passes, which is all a reader without types has.
    public string Get(string id) => Get(id, false);

    public string Get(string id, bool validate)
    {
        // 'repository' here is the primary constructor's parameter.
        var productId = validate ? new ProductId(id, true) : new ProductId(id);
        return repository.Load(productId);
    }

    public void Scan(string[] inputs)
    {
        // A block IS a scope, unlike Python: 'first' does not escape.
        if (inputs.Length > 0)
        {
            var first = inputs[0];
            Console.WriteLine(first);
        }

        foreach (var each in inputs)       // 'each' is defined by the foreach
        {
            Console.WriteLine(each);
        }

        try
        {
            Console.WriteLine(inputs[0].Trim());
        }
        catch (Exception error)            // 'error' is defined by the catch
        {
            Console.WriteLine(error);
        }

        if (inputs is string[] found)      // 'found' is defined by the pattern
        {
            Console.WriteLine(found.Length);
        }
    }
}

// A base class in the same tab; the hierarchy walk crosses tabs too.
public class ControllerBase
{
    protected string Name => GetType().Name;
}
`

/** The seed for a language. Only a link asking for one of the others gets it — the default buffer
 *  is still the TypeScript sample every embed and every test is written against. */
export function sampleFor(language: Language): string {
  if (language === 'py') return PYTHON_SAMPLE
  if (language === 'java') return JAVA_SAMPLE
  // One seed for both: they share a grammar, a backend and the rules the sample demonstrates.
  if (language === 'c' || language === 'cpp') return C_SAMPLE
  if (language === 'cs') return CSHARP_SAMPLE
  return SAMPLE
}
