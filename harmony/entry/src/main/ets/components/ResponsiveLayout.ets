/**
 * Pure viewport rules for the app shell. Ported from Tailscale-OHOS's
 * ResponsiveLayout.ets (`TransferContentLayout`/`SettingsContentLayout` and
 * their derivations dropped — cc-pet has no transfer or settings screens).
 *
 * Keyed off window *width*, never device type: HarmonyOS PC windows resize
 * freely and foldables change shape mid-session, so anything keyed off "is
 * this a tablet" breaks the moment the window itself doesn't match the
 * device class it shipped on. A phone in landscape and a resized PC window
 * hitting the same width should get the same layout.
 */
export enum ResponsiveWidthClass {
  COMPACT = 'compact',
  MEDIUM = 'medium',
  EXPANDED = 'expanded'
}

export class ResponsiveLayout {
  static readonly MEDIUM_MIN_WIDTH: number = 600;
  static readonly EXPANDED_MIN_WIDTH: number = 840;
  static readonly EXPANDED_CONTENT_MAX_WIDTH: number = 1240;

  static widthClass(width: number): ResponsiveWidthClass {
    if (width >= ResponsiveLayout.EXPANDED_MIN_WIDTH) {
      return ResponsiveWidthClass.EXPANDED;
    }
    if (width >= ResponsiveLayout.MEDIUM_MIN_WIDTH) {
      return ResponsiveWidthClass.MEDIUM;
    }
    return ResponsiveWidthClass.COMPACT;
  }

  static pageMargin(width: number): number {
    if (width >= ResponsiveLayout.EXPANDED_MIN_WIDTH) {
      return 32;
    }
    if (width >= ResponsiveLayout.MEDIUM_MIN_WIDTH) {
      return 24;
    }
    return 16;
  }

  /**
   * Session switching moves from a bottom sheet to a persistent side
   * column at the same MEDIUM boundary `widthClass` uses.
   */
  static usesSideSessions(width: number): boolean {
    return width >= ResponsiveLayout.MEDIUM_MIN_WIDTH;
  }

  /**
   * Caps chat content width once EXPANDED — otherwise a wide PC/tablet
   * window stretches message bubbles to unreadable line lengths. Below
   * that threshold this is a no-op (returns `width` itself), so callers can
   * apply it unconditionally as a `constraintSize({ maxWidth: ... })` at
   * every band without a separate EXPANDED check.
   */
  static contentMaxWidth(width: number): number {
    return width >= ResponsiveLayout.EXPANDED_MIN_WIDTH
      ? ResponsiveLayout.EXPANDED_CONTENT_MAX_WIDTH
      : width;
  }
}
