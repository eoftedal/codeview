#include <stdlib.h>
#include <string.h>

#include "wire.h"

enum wire_status store_name(struct record *target, struct frame incoming)
{
    if (incoming.count > strlen(incoming.payload)) {
        return WIRE_MALFORMED;
    }

    memcpy(target->name, incoming.payload, incoming.count);
    target->name[incoming.count] = '\0';
    target->length = incoming.count;
    return WIRE_OK;
}

enum wire_status set_name(struct record *target, struct frame incoming)
{
    if (incoming.count >= MAX_NAME) {
        return WIRE_TOO_LONG;
    }

    memcpy(target->name, incoming.payload, incoming.count);
    target->name[incoming.count] = '\0';
    target->length = incoming.count;
    return WIRE_OK;
}

struct record *record_new(size_t count)
{
    struct record *block = malloc(count * sizeof(struct record));
    if (block == NULL) {
        return NULL;
    }
    memset(block, 0, count * sizeof(struct record));
    return block;
}

void record_free(struct record *target)
{
    free(target);
}
