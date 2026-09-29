package ddspizza.domain;

public record ProductTitle(
    String value
) {
    public ProductTitle {
        if (value == null) throw new ValidationException("Title cannot be null");
        if (value.isBlank()) throw new ValidationException("Title cannot be blank");
        if (value.length() > 50) throw new ValidationException("Title cannot be over 50 characters");
        if (!value.matches("^[A-Za-z ]+")) throw new ValidationException("Title contains invalid characters");
    } 
}
