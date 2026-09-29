import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class AdminController {

    private final BackupService backups = new BackupService();
    private final FeedParser feeds = new FeedParser();
    private final Sessions sessions = new Sessions();

    @PostMapping("/admin/backup")
    public String backup(@RequestParam String label) {
        return backups.run(new BackupRequest(label));
    }

    @PostMapping("/admin/feed")
    public String feed(@RequestBody String document) {
        return feeds.titleOf(document);
    }

    @PostMapping("/admin/session")
    public String restore(@RequestBody byte[] state) {
        return sessions.restore(state);
    }

    @GetMapping("/admin/users/{id}/token")
    public String tokenFor(@PathVariable String id) {
        return sessions.tokenFor(id);
    }
}
