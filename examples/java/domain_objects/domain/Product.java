package ddspizza.domain;

public record Product(
    ProductId id,
    ProductTitle title,
    ProductDescription description
) {
    public Product {
        if (id == null) throw new ValidationException("Id cannot be null");
        if (title == null) throw new ValidationException("Title cannot be null");
        if (description == null) throw new ValidationException("Description cannot be null");
    }
}
