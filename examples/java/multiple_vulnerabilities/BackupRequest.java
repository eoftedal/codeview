public class BackupRequest {

    private final String label;
    private final String destination;

    public BackupRequest(String label) {
        this.label = label;
        this.destination = "/srv/backups";
    }

    public String command() {
        return "tar czf " + destination + "/" + label + ".tar.gz /srv/app";
    }
}
