using Microsoft.AspNetCore.Mvc;
using Shop.Domain;

namespace Shop.Api;

[ApiController]
public class ProductController(ProductRepository repository) : ControllerBase
{
    [HttpGet("/products/{id}")]
    public Product ById([FromRoute] string id)
    {
        var productId = new ProductId(id);
        return repository.Find(productId);
    }

    [HttpGet("/products")]
    public IReadOnlyList<Product> All([FromQuery] string sort)
    {
        return repository.ListSortedBy(sort);
    }

    [HttpGet("/products/search")]
    public IReadOnlyList<Product> Search([FromQuery] string name)
    {
        var filter = new ProductFilter { Name = name };
        return repository.Search(filter);
    }
}
