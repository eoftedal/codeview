package ddspizza.domain;

import java.util.UUID;

public record ProductId(
    String value
) {
    public ProductId {
        try {
            UUID.fromString(value);
        } catch (Exception e) {
            throw new ValidationException("Invalid product id: " + value);
        }
    }
}
