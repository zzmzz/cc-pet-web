import { SlashCommandSpec, SlashCommandCategory } from '../model/Protocol';
import { mergeCommands, matchCommands } from '../logic/slashCommands';
import { SessionStore } from '../store/SessionStore';

const CATEGORY_LABEL_BUILTIN: string = '本地命令';
const CATEGORY_LABEL_SESSION: string = '会话';
const CATEGORY_LABEL_AGENT: string = 'Agent';
const CATEGORY_LABEL_SKILL: string = 'Skill';

function categoryLabel(category: SlashCommandCategory): string {
  if (category === 'builtin') {
    return CATEGORY_LABEL_BUILTIN;
  } else if (category === 'session') {
    return CATEGORY_LABEL_SESSION;
  } else if (category === 'agent') {
    return CATEGORY_LABEL_AGENT;
  } else {
    return CATEGORY_LABEL_SKILL;
  }
}

const MENU_MAX_HEIGHT: number = 260;

/**
 * The command palette itself — no positioning logic here. `MessageInput`
 * owns anchoring this ABOVE the input row (Stack + per-child `.align`), per
 * the spec: on a phone the input sits against the keyboard, so anything
 * that opened downward from it would be covered immediately.
 *
 * Reads `SessionStore.connect().skillCommands` (a public `@Trace` field)
 * directly inside `build()` — that read is what registers this component as
 * a V2 render-dependency observer of skill commands arriving over
 * `bridge:skills-updated` (see `ConnectionGateway.dispatch` /
 * `SessionStore.applySkills`, both already wired before this task). No
 * `@Monitor`, no poll: this component simply re-renders whenever
 * `skillCommands` changes, the same pattern `MessageList`/`PetMini` use for
 * their stores.
 */
@ComponentV2
export struct SlashCommandMenu {
  @Require @Param input: string = '';
  @Param onPick: (spec: SlashCommandSpec) => void = (_spec: SlashCommandSpec): void => {};

  @Local private session: SessionStore = SessionStore.connect();

  private matches(): SlashCommandSpec[] {
    return matchCommands(mergeCommands(this.session.skillCommands), this.input);
  }

  /** O(n²) over a command list that never exceeds a few dozen entries — see class doc. */
  private isFirstOfCategory(spec: SlashCommandSpec, list: SlashCommandSpec[]): boolean {
    for (let i = 0; i < list.length; i++) {
      const candidate: SlashCommandSpec = list[i];
      if (candidate.command === spec.command) {
        return i === 0 || list[i - 1].category !== spec.category;
      }
    }
    return false;
  }

  /**
   * `Scroll` + plain `Column`, not `List` — a `List` with no explicit
   * `.height()` measured to zero here (confirmed on-device: nothing
   * rendered even with a forced-non-empty match list and a hardcoded `if
   * (true)`), because `List` sizes itself to an inherited constraint rather
   * than wrapping its content the way `Column` does. `Column` wrapping
   * content, capped by `Scroll`'s `constraintSize`, is the same
   * wrap-then-cap shape `MarkdownView` already uses successfully
   * (`Column({ space: 10 }) { ForEach(...) }`, no `List` involved) — this
   * command list is at most a few dozen rows, nowhere near where `List`'s
   * lazy-instantiation would matter.
   */
  build() {
    Scroll() {
      Column({ space: 0 }) {
        ForEach(this.matches(), (spec: SlashCommandSpec) => {
          this.renderRow(spec)
        }, (spec: SlashCommandSpec) => spec.command)
      }
      .width('100%')
    }
    .width('100%')
    .constraintSize({ maxHeight: MENU_MAX_HEIGHT })
    .backgroundColor(Color.White)
    .borderRadius(12)
    .shadow({ radius: 8, color: '#00000026', offsetY: -2 })
    .padding({ top: 4, bottom: 4 })
  }

  @Builder
  renderRow(spec: SlashCommandSpec) {
    Column() {
      if (this.isFirstOfCategory(spec, this.matches())) {
        Text(categoryLabel(spec.category))
          .fontSize(11)
          .fontColor('#8A8F98')
          .padding({ left: 12, right: 12, top: 8, bottom: 4 })
      }
      Row({ space: 8 }) {
        Text(spec.command)
          .fontSize(14)
          .fontWeight(FontWeight.Medium)
          .fontColor('#1F2328')
        Text(spec.description)
          .fontSize(12)
          .fontColor('#8A8F98')
          .layoutWeight(1)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
      }
      .width('100%')
      .padding({ left: 12, right: 12, top: 6, bottom: 6 })
      .onClick(() => { this.onPick(spec); })
    }
    .width('100%')
  }
}
