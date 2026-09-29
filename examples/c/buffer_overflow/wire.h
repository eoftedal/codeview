#ifndef WIRE_H
#define WIRE_H

#include <stddef.h>

#define MAX_NAME 32

enum wire_status { WIRE_OK, WIRE_TOO_LONG, WIRE_MALFORMED };

struct record {
    char name[MAX_NAME];
    size_t length;
};

struct frame {
    const char *payload;
    size_t count;
};

enum wire_status store_name(struct record *target, struct frame incoming);
enum wire_status set_name(struct record *target, struct frame incoming);
struct record *record_new(size_t count);
void record_free(struct record *target);

#endif
