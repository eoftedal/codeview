import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;

@RestController
public class DocumentController {

    private final DocumentService documents = new DocumentService();

    @GetMapping("/documents")
    public ResponseEntity<byte[]> download(@RequestParam String name) {
        var request = new DownloadRequest(name, "application/pdf");
        return ResponseEntity.ok().header("Content-Type", request.contentType()).body(documents.read(request));
    }

    @PostMapping("/documents")
    public String upload(MultipartFile file) {
        return documents.store(file.getOriginalFilename(), file);
    }
}
