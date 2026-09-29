import java.util.List;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class ReportController {

    private final ReportRepository reports = new ReportRepository();

    @GetMapping("/reports/{id}")
    public Report byId(@PathVariable String id, @RequestParam String team) {
        return reports.find(new ReportQuery(id, team));
    }

    @GetMapping("/reports")
    public List<Report> recent(@RequestParam String team, @RequestParam String orderBy) {
        return reports.recent(team, orderBy);
    }

    @GetMapping("/reports/count")
    public long count(@RequestParam String team) {
        return reports.countFor(team);
    }
}
