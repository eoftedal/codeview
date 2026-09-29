package ddspizza.dto;

import ddspizza.domain.*;

import com.fasterxml.jackson.annotation.JsonRootName; 

import io.swagger.v3.oas.annotations.media.*;


@JsonRootName(value = "newComment")
public record NewCommentDto(
    @Schema(example = "joanna")
    String author,
    @Schema(example = "This pizza tastes great")
    String body
) {
    public Comment toDomain(ProductId productId) {
        return new Comment(
            Comment.Id.generate(),
            productId,
            new Comment.Author(this.author),
            new Comment.Body(this.body)
        );
    }
}
