package ddspizza;
import java.util.Base64;
import java.util.List;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.security.MessageDigest;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import java.util.stream.Collectors;
import ddspizza.domain.*;
import ddspizza.dto.*;

import io.swagger.v3.oas.annotations.*;
import io.swagger.v3.oas.annotations.info.*;
import io.swagger.v3.oas.annotations.media.*;
import io.swagger.v3.oas.annotations.responses.*;
import io.swagger.v3.oas.annotations.servers.*;



@RestController
@OpenAPIDefinition(
    info = @Info(title = "Pizza API", version = "2.0", description = "Pizza Information"),
    servers = { @Server(url="https://some.hackable.network:8449"), @Server(url="http://localhost:8090"), @Server(url="http://localhost:8111") }
)
public class ProductController  {
    Logger logger = LoggerFactory.getLogger(ProductController.class);
    private ProductRepository repo;

    public ProductController(ProductRepository repo) {
        this.repo = repo;
    }

    @GetMapping(value = "/product/{id}", produces = "application/json")
    @ApiResponses(value = { 
        @ApiResponse(responseCode = "200", description = "Found the pizza", 
          content = { @Content(mediaType = "application/json", 
            schema = @Schema(implementation = ProductDto.class)) }),
        @ApiResponse(responseCode = "400", description = "Invalid id supplied", 
          content = @Content), 
        @ApiResponse(responseCode = "404", description = "Pizza not found", 
          content = @Content) })
    public ProductDto productById(@PathVariable @Parameter(name="id", schema = @Schema(description = "id",type = "string", format="uuid", example="10fb7d37-b49b-41a0-817d-d76068fb3844")) String id) {
        var productId = new ProductId(id);
        var pizza = repo.getPizza(productId);
        if (!pizza.isPresent()) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "No such pizza");
        }
        return ProductDto.from(pizza.get());
    }

    @GetMapping(value = "/product/{id}/comment/", produces = "application/json")
    @ApiResponses(value = { 
        @ApiResponse(responseCode = "200", description = "Found comments for the pizza"),
        @ApiResponse(responseCode = "400", description = "Invalid id supplied", 
          content = @Content)
    })
    public List<CommentDto> getComments(
        @PathVariable @Parameter(name="id", schema = @Schema(description = "id",type = "string", format="uuid", example="10fb7d37-b49b-41a0-817d-d76068fb3844")) String id
    ) {
        var productId = new ProductId(id);
        var comments = repo.getComments(productId);
        return comments.stream().map(CommentDto::from).collect(Collectors.toList());
    }

    @PostMapping(value = "/product/{id}/comment/", produces = "application/json")
    @ApiResponses(value = { 
        @ApiResponse(responseCode = "200", description = "Comment stored", 
          content = { @Content(mediaType = "application/json", 
            schema = @Schema(implementation = CommentDto.class)) }),
        @ApiResponse(responseCode = "400", description = "Invalid id or invalid data supplied", 
          content = @Content)})
    public CommentDto createComment(
        @PathVariable @Parameter(name="id", schema = @Schema(description = "id",type = "string", format="uuid", example="10fb7d37-b49b-41a0-817d-d76068fb3844")) String id,
        @RequestBody NewCommentDto comment
    ) {
        var productId = new ProductId(id);
        var newComment = comment.toDomain(productId);
        repo.storeComment(newComment);
        return CommentDto.from(newComment);
    }

    @PutMapping(value = "/product/{productId}/comment/{commentId}", produces = "application/json")
    @ApiResponses(value = { 
        @ApiResponse(responseCode = "200", description = "Comment updated", 
          content = { @Content(mediaType = "application/json", 
            schema = @Schema(implementation = CommentDto.class)) }),
        @ApiResponse(responseCode = "400", description = "Invalid id or invalid data supplied", 
          content = @Content),
          @ApiResponse(responseCode = "404", description = "Could not find the comment to update", 
          content = @Content)
        })
    public CommentDto updateComment(
        @PathVariable @Parameter(name="productId", schema = @Schema(description = "productId",type = "string", format="uuid", example="20fb7d37-b49b-41a0-817d-d76068fb3844")) String productId,
        @PathVariable @Parameter(name="commentId", schema = @Schema(description = "commentId",type = "string", format="uuid", example="20fb7d37-b49b-41a0-817d-d76068fb3844")) String commentId,
        @RequestBody CommentDto comment
    ) {
        var convertedComment = comment.toDomain();
        repo.updateComment(convertedComment);
        return CommentDto.from(convertedComment);
    }

    @GetMapping(value = "/product/", produces = "application/json")
    public List<ProductDto> products(
            @RequestParam(required = false) @Parameter(name="search", schema = @Schema(description = "search word",type = "string", example="tomato")) String search
        ) {
        var pizzas = repo.getPizzas(search);
        return pizzas.stream().map(ProductDto::from).collect(Collectors.toList());
    }

    @GetMapping(value = "/health")
    @ApiResponses(value = { 
        @ApiResponse(responseCode = "200", description = "Health status", 
          content = { @Content(mediaType = "application/json", 
            schema = @Schema(implementation = String.class)) }),
        @ApiResponse(responseCode = "500", description = "Something went wrong", 
          content = @Content),
          @ApiResponse(responseCode = "403", description = "Invalid key", 
          content = @Content)
        })
    public ResponseEntity<String> health(@RequestParam(required = true) @Parameter(name="apiKey") String apiKey) {
        try {
            var md = MessageDigest.getInstance("MD5");
            var bytes = apiKey.getBytes();
            md.update(bytes);
            var digest = Base64.getEncoder().encodeToString(md.digest());
            logger.info("digest: " + digest);
            if (!"IDT24ylYZH/f910mW0Vevw==".equals(digest)) {
                return ResponseEntity.status(HttpStatus.FORBIDDEN).body("Forbidden. Invalid key");
            }
        } catch(Exception ex) {
            logger.warn("Failed to check health key", ex);
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body("Something went bonk in the night");
        }
        //check database connection by polling data
        repo.getPizzas("");
        return ResponseEntity.status(HttpStatus.OK).body("Everything is ok");    
    }

    @ExceptionHandler(ValidationException.class)
    @ResponseStatus(HttpStatus.BAD_REQUEST)
    public @ResponseBody ResponseEntity<ErrorDto> handleException(ValidationException ex) {
        logger.warn("Validation error: " + ex.getMessage());
        return ResponseEntity.status(HttpStatus.BAD_REQUEST).body(new ErrorDto("Mission failed: " + ex.getMessage()));
    }

    @ExceptionHandler(ResponseStatusException.class )
    public @ResponseBody ResponseEntity<ErrorDto> handleException(ResponseStatusException ex) {
        logger.warn("Response status: " + ex);
        return ResponseEntity.status(ex.getStatusCode()).body(new ErrorDto("Mission failed: " + ex.getMessage()));
    }

    @ExceptionHandler(Exception.class)
    @ResponseStatus(HttpStatus.INTERNAL_SERVER_ERROR)
    public @ResponseBody ResponseEntity<ErrorDto> handleAllExceptions(Exception ex) {
        logger.warn("Not expected: " + ex, ex);
        return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body(new ErrorDto("Mission failed: " + ex.getMessage()));
    }


}
