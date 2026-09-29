import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import org.springframework.web.multipart.MultipartFile;

public class DocumentService {

    private static final String ROOT = "/srv/app/documents";

    public byte[] read(DownloadRequest request) {
        File target = new File(ROOT, request.name());
        try {
            return Files.readAllBytes(target.toPath());
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
    }

    public String store(String name, MultipartFile file) {
        Path target = Path.of(ROOT, name);
        try {
            file.transferTo(target);
            return target.toString();
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
    }

    public byte[] load(String name) throws IOException {
        Path root = Path.of(ROOT).toRealPath();
        Path target = root.resolve(name).normalize();
        if (!target.startsWith(root)) {
            throw new IllegalArgumentException("outside the document root");
        }
        return Files.readAllBytes(target);
    }
}
