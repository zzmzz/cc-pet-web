import { PetState, TaskPhase } from '../model/Protocol';

export const HAPPY_WINDOW_MS: number = 3000;

export interface PetInputs {
  taskPhase: TaskPhase;
  hasUnread: boolean;
  bridgeConnected: boolean;
  msSinceConnected: number;
}

/**
 * Pet state is derived, never set imperatively. Priority is fixed and total:
 * error > working > fresh-connection > unread > idle.
 */
export function derivePetState(inputs: PetInputs): PetState {
  if (!inputs.bridgeConnected) {
    return 'error';
  }
  if (inputs.taskPhase === 'working' || inputs.taskPhase === 'thinking') {
    return 'thinking';
  }
  if (inputs.msSinceConnected <= HAPPY_WINDOW_MS) {
    return 'happy';
  }
  if (inputs.hasUnread) {
    return 'talking';
  }
  return 'idle';
}
