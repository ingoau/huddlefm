package kotlin.coroutines.jvm.internal;

import kotlin.coroutines.Continuation;
import kotlin.coroutines.CoroutineContext;

/** Compile-only stub of the base of Kotlin's suspend function state machines. */
public abstract class ContinuationImpl implements Continuation<Object> {
  public ContinuationImpl(Continuation<Object> completion) {}

  protected abstract Object invokeSuspend(Object result);

  @Override
  public CoroutineContext getContext() {
    return null;
  }

  @Override
  public void resumeWith(Object result) {}
}
