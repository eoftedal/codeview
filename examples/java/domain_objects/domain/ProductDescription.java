package ddspizza.domain;

public record ProductDescription(
    String value
) {
    public ProductDescription {
        if (value == null) throw new ValidationException("Description cannot be null");
        if (value.isBlank()) throw new ValidationException("Description cannot be blank");
        if (value.length() > 500) throw new ValidationException("Description cannot be over 100 characters");
        if (!value.matches("^[A-Za-z,() ]+")) throw new ValidationException("Description contains invalid characters");
    }
}
