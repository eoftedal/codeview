# Stack and heap overflow from a length the peer chose (C, three files)

`fscanf("%lu:")` → `frame.count` → `memcpy` into a 32-byte field.

|         |                                                                            |
| ------- | -------------------------------------------------------------------------- |
| Source  | `read_frame` in `server.c` — the declared length is whatever the peer sent |
| Sink    | `memcpy` in `wire.c`, and the indexed writes in `handle_batch`             |
| Carrier | `struct frame`, whose `count` travels beside the payload it describes      |

**There is no backward trace for C — the Trace tab says so, and this sample is written for that.**
The flows here run through pointers, which is the reason the language has none: `incoming.payload`
is a `const char *` into `scratch`, and a walk that followed it would have to model aliasing or
quietly stop. So this slug is for the syntax tree and the definition highlight, and for reading the
code with a hunter brief — **Memory safety** is the one written for it. The definitions do cross the
`#include`: click `MAX_NAME`, `store_name` or `WIRE_OK` in either `.c` and the answer lands on the
`#include "wire.h"` line with `defined in wire.h` beside it, because the declaration has no range on
screen.

Things worth checking a reading against:

- **The bound in `store_name` is checked against the wrong thing.** `incoming.count > strlen(payload)`
  compares the peer's number with the length of what is being copied _from_, never with `MAX_NAME`,
  which is the size of what is being copied _into_. The comparison is not missing — it is present,
  plausible and useless, which is the shape this bug usually takes.
- **`target->name[incoming.count] = '\0'` writes one past the copy**, so even a length equal to
  `MAX_NAME` is an off-by-one on top of the overflow.
- **`record_new` multiplies before it allocates.** `count * sizeof(struct record)` can wrap, so a
  large count returns a small block and every write after it is out of bounds. The arithmetic is the
  bug, not the `malloc`.
- **`handle_batch` frees on the error path and keeps going.** `record_free(batch)` runs inside the
  loop without breaking, so the next iteration writes into freed memory and the `printf` below reads
  from it — then frees it a second time. Its loop is also `i <= count`, one past the end.
- **`set_name` is the same copy with the bound checked against `MAX_NAME`**, and is called by
  nothing. Neither name says which is which; the check does.
- `scratch` in `handle` is a stack buffer, so the overflow in `store_name` runs over `target` and
  whatever the frame holds after it.

Nothing here is code to copy. The file compiles and the overflow is reachable with a single frame
whose declared length exceeds 32.
