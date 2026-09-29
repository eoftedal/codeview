import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.util.stream.Collectors;

public class BackupService {

    public String run(BackupRequest request) {
        try {
            Process process = Runtime.getRuntime().exec(new String[] {"sh", "-c", request.command()});
            try (BufferedReader out = new BufferedReader(new InputStreamReader(process.getInputStream()))) {
                return out.lines().collect(Collectors.joining("\n"));
            }
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
    }
}
