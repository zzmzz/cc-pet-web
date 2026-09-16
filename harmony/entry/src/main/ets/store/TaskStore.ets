import { AppStorageV2 } from '@kit.ArkUI';
import { TaskPhase } from '../model/Protocol';

const APP_STORAGE_KEY: string = 'TaskStore';

/**
 * Must be obtained through `AppStorageV2.connect()` — see Global Constraints
 * in docs/superpowers/plans/2026-09-15-harmony-client.md and
 * .superpowers/sdd/2026-09-15-harmony-client/reactivity-fix-report.md for
 * why a bare `static readonly instance` does not register consumers as V2
 * observers. A `private constructor()` was not attempted here — it is known
 * to fail ArkTS compilation (see AuthStore.ets for the exact error); the
 * single-access-point rule is enforced by convention/review only.
 */
@ObservedV2
export class TaskStore {
  static connect(): TaskStore {
    const instance: TaskStore | undefined =
      AppStorageV2.connect(TaskStore, APP_STORAGE_KEY, (): TaskStore => new TaskStore());
    if (instance === undefined) {
      throw new Error('TaskStore.connect(): AppStorageV2.connect returned undefined');
    }
    return instance;
  }

  @Trace private phases: Map<string, TaskPhase> = new Map<string, TaskPhase>();

  phaseOf(chatKey: string): TaskPhase {
    return this.phases.get(chatKey) ?? 'idle';
  }

  setPhase(chatKey: string, phase: TaskPhase): void {
    this.phases.set(chatKey, phase);
  }

  /**
   * Forget this chat's phase entirely, so `phaseOf` falls back to `'idle'`.
   *
   * `delete`, not `setPhase(chatKey, 'idle')`: the two are indistinguishable
   * through `phaseOf`, but only the delete stops a session key that is about
   * to be reused from carrying an entry for a conversation that no longer
   * exists. Web's `clearSessionTaskState` deletes for the same reason.
   * `ConnectionGateway.resetSessionResidue` is the only caller.
   */
  clearPhase(chatKey: string): void {
    this.phases.delete(chatKey);
  }
}
