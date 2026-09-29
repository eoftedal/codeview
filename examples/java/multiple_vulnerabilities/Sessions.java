import java.io.ByteArrayInputStream;
import java.io.ObjectInputStream;
import java.security.MessageDigest;
import java.util.Base64;

public class Sessions {

    private static final String SIGNING_KEY = "changeme-signing-key";

    public String restore(byte[] state) {
        try (ObjectInputStream in = new ObjectInputStream(new ByteArrayInputStream(state))) {
            return String.valueOf(in.readObject());
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    public String tokenFor(String userId) {
        try {
            MessageDigest digest = MessageDigest.getInstance("MD5");
            byte[] hash = digest.digest((userId + SIGNING_KEY).getBytes());
            return Base64.getEncoder().encodeToString(hash);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }
}
