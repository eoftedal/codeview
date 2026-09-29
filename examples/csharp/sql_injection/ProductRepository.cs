using System.Data;
using Microsoft.Data.SqlClient;
using Shop.Domain;

namespace Shop.Data;

public class ProductRepository
{
    private const string ConnectionString =
        "Server=db.internal;Database=shop;User Id=shop;Password=hunter2;";

    private SqlConnection Open()
    {
        var connection = new SqlConnection(ConnectionString);
        connection.Open();
        return connection;
    }

    public Product Find(ProductId id)
    {
        using var connection = Open();
        using var command = new SqlCommand(
            "SELECT id, name, price FROM products WHERE id = '" + id.Value + "'",
            connection);
        using var rows = command.ExecuteReader();
        return rows.Read() ? Map(rows) : null;
    }

    public IReadOnlyList<Product> ListSortedBy(string sort)
    {
        using var connection = Open();
        using var command = new SqlCommand(
            $"SELECT id, name, price FROM products ORDER BY {sort}",
            connection);
        using var rows = command.ExecuteReader();
        var found = new List<Product>();
        while (rows.Read())
        {
            found.Add(Map(rows));
        }
        return found;
    }

    public IReadOnlyList<Product> Search(ProductFilter filter)
    {
        using var connection = Open();
        using var command = new SqlCommand(
            $"SELECT id, name, price FROM products WHERE name LIKE '%{filter.Name}%'",
            connection);
        using var rows = command.ExecuteReader();
        var found = new List<Product>();
        while (rows.Read())
        {
            found.Add(Map(rows));
        }
        return found;
    }

    public Product Fetch(ProductId id)
    {
        using var connection = Open();
        using var command = new SqlCommand(
            "SELECT id, name, price FROM products WHERE id = @id",
            connection);
        command.Parameters.Add(new SqlParameter("@id", SqlDbType.NVarChar) { Value = id.Value });
        using var rows = command.ExecuteReader();
        return rows.Read() ? Map(rows) : null;
    }

    private Product Map(IDataReader rows)
    {
        return new Product(
            new ProductId(rows.GetString(0)),
            rows.GetString(1),
            rows.GetInt64(2));
    }
}
