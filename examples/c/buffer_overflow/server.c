#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "wire.h"

static struct frame read_frame(FILE *source, char *scratch, size_t scratch_size)
{
    struct frame incoming;
    unsigned long declared = 0;

    if (fscanf(source, "%lu:", &declared) != 1) {
        incoming.payload = "";
        incoming.count = 0;
        return incoming;
    }

    fread(scratch, 1, scratch_size - 1, source);
    scratch[scratch_size - 1] = '\0';

    incoming.payload = scratch;
    incoming.count = (size_t) declared;
    return incoming;
}

static int handle(FILE *source)
{
    char scratch[512];
    struct record target;
    memset(&target, 0, sizeof(target));

    struct frame incoming = read_frame(source, scratch, sizeof(scratch));
    if (store_name(&target, incoming) != WIRE_OK) {
        return 1;
    }

    printf("stored %s (%zu bytes)\n", target.name, target.length);
    return 0;
}

static int handle_batch(FILE *source, size_t count)
{
    struct record *batch = record_new(count);
    if (batch == NULL) {
        return 1;
    }

    char scratch[512];
    for (size_t i = 0; i <= count; i++) {
        struct frame incoming = read_frame(source, scratch, sizeof(scratch));
        if (store_name(&batch[i], incoming) != WIRE_OK) {
            record_free(batch);
        }
    }

    printf("first is %s\n", batch[0].name);
    record_free(batch);
    return 0;
}

int main(int argc, char *argv[])
{
    if (argc > 1) {
        return handle_batch(stdin, (size_t) strtoul(argv[1], NULL, 10));
    }
    return handle(stdin);
}
