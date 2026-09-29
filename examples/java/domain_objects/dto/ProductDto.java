package ddspizza.dto;

import ddspizza.domain.*;
import com.fasterxml.jackson.annotation.JsonRootName; 

import io.swagger.v3.oas.annotations.media.*;

@JsonRootName(value = "product")
public record ProductDto(
    @Schema(format = "uuid")
    String id,
    @Schema(example = "Margherita")
    String title,
    @Schema(example = "Contains tomato and mozarella")
    String description
) {
    public static ProductDto from(Product product) {
        return new ProductDto(product.id().value(), product.title().value(), product.description().value());
    }
}

