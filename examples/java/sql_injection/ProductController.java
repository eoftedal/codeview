import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class ProductController {

    private final ProductRepository repository;

    public ProductController(ProductRepository repository) {
        this.repository = repository;
    }

    @GetMapping("/products/{id}")
    public Product byId(@PathVariable String id) {
        var productId = new ProductId(id);
        return repository.find(productId);
    }

    @GetMapping("/products")
    public java.util.List<Product> all(@RequestParam String sort) {
        return repository.listSortedBy(sort);
    }
}
