import { ConnectionStore, ConnectionPhase } from '../store/ConnectionStore';

const LABEL_CONNECTED: string = '已连接';
const LABEL_CONNECTING: string = '连接中';
const LABEL_BACKOFF: string = '重连中';
const LABEL_DISCONNECTED: string = '未连接';

const COLOR_CONNECTED: string = '#12B76A';
const COLOR_CONNECTING: string = '#F79009';
const COLOR_BACKOFF: string = '#F79009';
const COLOR_DISCONNECTED: string = '#8A8F98';

function labelFor(phase: ConnectionPhase): string {
  if (phase === 'connected') {
    return LABEL_CONNECTED;
  } else if (phase === 'connecting') {
    return LABEL_CONNECTING;
  } else if (phase === 'backoff') {
    return LABEL_BACKOFF;
  } else {
    return LABEL_DISCONNECTED;
  }
}

function colorFor(phase: ConnectionPhase): string {
  if (phase === 'connected') {
    return COLOR_CONNECTED;
  } else if (phase === 'connecting') {
    return COLOR_CONNECTING;
  } else if (phase === 'backoff') {
    return COLOR_BACKOFF;
  } else {
    return COLOR_DISCONNECTED;
  }
}

/**
 * Small persistent top-bar pill showing `ConnectionStore.phase`. Reads the
 * store directly inside `build()` — same "no @Monitor needed for render
 * deps" pattern `PetMini`/`MessageList` already use — so it re-renders
 * whenever `ConnectionGateway` writes a new phase (`connecting` ->
 * `connected` -> `backoff` -> ... ), with no poll.
 */
@ComponentV2
export struct ConnectionBadge {
  @Local private connection: ConnectionStore = ConnectionStore.connect();

  build() {
    Row({ space: 4 }) {
      Circle().width(6).height(6).fill(colorFor(this.connection.phase))
      Text(labelFor(this.connection.phase)).fontSize(11).fontColor('#5A5F66')
    }
    .padding({ left: 8, right: 8, top: 3, bottom: 3 })
    .backgroundColor('#F1F3F5')
    .borderRadius(10)
  }
}
