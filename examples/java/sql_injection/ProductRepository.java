import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.List;

public class ProductRepository {

    private Connection open() throws SQLException {
        return DriverManager.getConnection("jdbc:postgresql://db.internal/shop", "shop", "hunter2");
    }

    public Product find(ProductId id) {
        try (Statement statement = open().createStatement()) {
            ResultSet rows =
                    statement.executeQuery("SELECT id, name, price FROM products WHERE id = '" + id.value() + "'");
            return rows.next() ? map(rows) : null;
        } catch (SQLException e) {
            throw new IllegalStateException(e);
        }
    }

    public List<Product> listSortedBy(String sort) {
        List<Product> found = new ArrayList<>();
        try (Statement statement = open().createStatement()) {
            ResultSet rows = statement.executeQuery("SELECT id, name, price FROM products ORDER BY " + sort);
            while (rows.next()) {
                found.add(map(rows));
            }
            return found;
        } catch (SQLException e) {
            throw new IllegalStateException(e);
        }
    }

    public Product fetch(ProductId id) throws SQLException {
        try (PreparedStatement statement =
                open().prepareStatement("SELECT id, name, price FROM products WHERE id = ?")) {
            statement.setString(1, id.value());
            ResultSet rows = statement.executeQuery();
            return rows.next() ? map(rows) : null;
        }
    }

    private Product map(ResultSet rows) throws SQLException {
        return new Product(new ProductId(rows.getString("id")), rows.getString("name"), rows.getLong("price"));
    }
}
