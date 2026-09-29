package ddspizza.dto;

import ddspizza.domain.*;

import com.fasterxml.jackson.annotation.JsonRootName; 

import io.swagger.v3.oas.annotations.media.*;

@JsonRootName(value = "comment")
public record CommentDto(
    @Schema(format = "uuid")
    String id,
    @Schema(format = "uuid")
    String productId,
    @Schema(example = "joanna")
    String author,
    @Schema(example = "This pizza tastes great")
    String body
) {
    public static CommentDto from(Comment comment) {
        return new CommentDto(comment.id().value(), comment.productId().value(), comment.author().value(), comment.body().value());
    }
    public Comment toDomain() {
        return new Comment(
            new Comment.Id(this.id),
            new ProductId(this.productId),
            new Comment.Author(this.author),
            new Comment.Body(this.body)
        );
    }    
}
