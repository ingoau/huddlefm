package kotlin.coroutines;

/** Compile-only stub. */
public interface Continuation<T> {
  CoroutineContext getContext();

  void resumeWith(Object result);
}
