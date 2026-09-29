package ddspizza.domain;

import java.util.UUID;

public record Comment(
    Id id,
    ProductId productId,
    Author author,
    Body body
) {
    public Comment {
        if (id == null) throw new ValidationException("Id cannot be null");
        if (productId == null) throw new ValidationException("ProductId cannot be null");
        if (author == null) throw new ValidationException("Author cannot be null");
        if (body == null) throw new ValidationException("Body cannot be null");
    }

    public static record Id(String value) {
        public Id {
            try {
                UUID.fromString(value);
            } catch (Exception e) {
                throw new ValidationException("Invalid comment id: " + value);
            }
        }

        public static Id generate() {
            return new Id(UUID.randomUUID().toString());
        }
    }

    public static record Author(String value) {
        public Author {
            if (value == null) throw new ValidationException("Author cannot be null");
            if (value.length() > 20) throw new ValidationException("Author cannot be longer than 20");
            if (!value.matches("^[A-Za-z ]+")) throw new ValidationException("Author contains invalid characters");
        }
    }

    public static record Body(String value) {
        public Body {
            if (value == null) throw new ValidationException("Body cannot be null");
            if (value.length() > 300) throw new ValidationException("Body cannot be longer than 300");
            if (!value.matches("^[A-Za-z '\"(),.\\-0-9]+")) throw new ValidationException("Body contains invalid characters");
        }
    }
}
