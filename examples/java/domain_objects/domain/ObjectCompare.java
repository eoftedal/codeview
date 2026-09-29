package ddspizza.domain;

import java.util.function.Predicate;

public class ObjectCompare {
    @SuppressWarnings("unchecked")
    public static <T> boolean compare(T a, Object b, Predicate<T> comparer) {
        if (a == null && b == null) return true;
        if (b == null || a == null) return false;
        if (!b.getClass().isAssignableFrom(a.getClass())) return false;
        return comparer.test((T)b);
    }    
}
