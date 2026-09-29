package ddspizza;

import ddspizza.domain.*;
import org.jdbi.v3.core.*;
import org.springframework.stereotype.Service;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.InitializingBean;

import java.util.Optional;
import java.util.List;

@Service
public class ProductRepository implements InitializingBean {
    Logger logger = LoggerFactory.getLogger(ProductRepository.class);

    private Jdbi jdbi = null;
    public ProductRepository() {
    }

    public Optional<Product> getPizza(ProductId id) {
        return jdbi.withHandle(handle -> {
            var query = handle.createQuery("SELECT id, title, description FROM Pizza WHERE id='" + id.value() + "'");
            return query.map((rs, _ctx) -> new Product(
                new ProductId(rs.getString("id")),
                new ProductTitle(rs.getString("title")),
                new ProductDescription(rs.getString("description"))
            )).list();
        }).stream().findFirst();
    }

    public List<Product> getPizzas(String search) {
        return jdbi.withHandle(handle -> {
            String query = "SELECT id, title, description FROM Pizza";
            if (search != null && !search.isBlank()) {
                query += " WHERE lower(description) LIKE '%" + search.toLowerCase() + "%'";
            }
            return handle.createQuery(query).map((rs, _ctx) -> new Product(
                new ProductId(rs.getString("id")),
                new ProductTitle(rs.getString("title")),
                new ProductDescription(rs.getString("description"))
            )).list();
        });
    }

    public void storeComment(Comment comment) {
        jdbi.withHandle(handle -> {
            return handle.createUpdate("INSERT INTO Comment(id, productId, author, body) VALUES (:id, :productId, :author, :body)")
                .bind("id", comment.id().value())
                .bind("productId", comment.productId().value())
                .bind("author", comment.author().value())
                .bind("body", comment.body().value())
                .execute();
        });
    }
    public void updateComment(Comment comment) {
        jdbi.withHandle(handle -> {
            return handle.createUpdate("UPDATE Comment SET body='" + comment.body().value() + "' WHERE id='" + comment.id().value() + "'")
                .execute();
        });
    }
    public List<Comment> getComments(ProductId id) {
        return jdbi.withHandle(handle -> {
            String query = "SELECT id, productId, author, body FROM Comment WHERE productId='" + id.value() + "'";
            return handle.createQuery(query).map((rs, _ctx) -> new Comment(
                new Comment.Id(rs.getString("id")),
                new ProductId(rs.getString("productId")),
                new Comment.Author(rs.getString("author")),
                new Comment.Body(rs.getString("body"))
            )).list();
        });
    }


    @Override
    public void afterPropertiesSet() throws Exception {
        init();
    }

    public void init() {
        logger.info("Creating the Repository");
        jdbi = Jdbi.create("jdbc:hsqldb:mem:testDB", "sa", "");
        jdbi.useHandle(handle -> {
            handle.execute("CREATE TABLE IF NOT EXISTS Pizza (id varchar(50) primary key, title varchar(50) not null, description varchar(100) not null)");
            handle.execute("DELETE FROM Pizza");
            handle.execute("INSERT INTO Pizza(id, title, description ) VALUES ('10fb7d37-b49b-41a0-817d-d76068fb3844', 'Margherita', 'Tomato sauce, mozzarella, and oregano')");
            handle.execute("INSERT INTO Pizza(id, title, description ) VALUES ('f9e304d3-c620-4382-bcba-a6c36bc9ed91', 'Marinara', 'Tomato sauce, garlic and basil')");
            handle.execute("INSERT INTO Pizza(id, title, description ) VALUES ('097ba132-c78d-4330-a0f6-ac6d239a48e8', 'Quattro Stagioni', 'Tomato sauce, mozzarella, mushrooms, ham, artichokes, olives, and oregano')");
            handle.execute("INSERT INTO Pizza(id, title, description ) VALUES ('661a79eb-01aa-4f56-bf0e-53421f67e792', 'Carbonara', 'Tomato sauce, mozzarella, parmesan, eggs, and bacon')");
            handle.execute("INSERT INTO Pizza(id, title, description ) VALUES ('6d779f36-9a65-44f6-aa3d-43e698dcb082', 'Frutti di Mare', 'Tomato sauce and seafood')");
            handle.execute("INSERT INTO Pizza(id, title, description ) VALUES ('d935372a-7734-4dbf-a675-3d57522dc366', 'Quattro Formaggi', 'Tomato sauce, mozzarella, parmesan, gorgonzola cheese, artichokes, and oregano')");
            handle.execute("INSERT INTO Pizza(id, title, description ) VALUES ('364508c7-ce66-4053-a062-43abae87cea9', 'Crudo', 'Tomato sauce, mozzarella and Parma ham')");
            handle.execute("INSERT INTO Pizza(id, title, description ) VALUES ('0210406c-979f-44eb-9d3e-758d6219782d', 'Napoletana or Napoli', 'Tomato sauce, mozzarella, oregano, anchovies')");
            handle.execute("INSERT INTO Pizza(id, title, description ) VALUES ('7384557e-2907-4948-8da9-d57c4e8bd38e', 'Pugliese', 'Tomato sauce, mozzarella, oregano, and onions')");
            handle.execute("INSERT INTO Pizza(id, title, description ) VALUES ('6d7f6d90-4ad0-44cf-8b4b-7afb54ca9805', 'Montanara', 'Tomato sauce, mozzarella, mushrooms, pepperoni, and Stracchino (soft cheese)')");        

            handle.execute("CREATE TABLE IF NOT EXISTS Comment (id varchar(50) primary key, productId varchar(50), author varchar(20) not null, body varchar(300) not null)");
            handle.execute("DELETE FROM Comment");
            handle.execute("INSERT INTO Comment(id, productId, author, body ) VALUES ('20fb7d37-b49b-41a0-817d-d76068fb3844', '10fb7d37-b49b-41a0-817d-d76068fb3844', 'joanna', 'This tastes excellent!')");        

        });
        logger.info("Database setup");
    }


}
