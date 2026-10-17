/**
 * Motion tokens.
 *
 * One source of truth for timing, shared by the stylesheet and the animation
 * engine. Keeping these in TypeScript means a component asks for
 * `motion.duration.base` rather than inventing `0.6` or `600` somewhere and
 * drifting out of step with the rest of the site.
 *
 * The CSS equivalents live in `global.css` as custom properties.
 */

export const motion = {
  /**
   * Seconds, matching GSAP's unit. Fast is reserved for state changes that must
   * feel instant; `cinematic` is only for the hero.
   */
  duration: {
    fast: 0.24,
    base: 0.62,
    slow: 0.92,
    cinematic: 1.25,
  },

  /** Seconds between siblings. Tight for dense lists, loose for hero lines. */
  stagger: {
    tight: 0.055,
    base: 0.085,
    loose: 0.13,
  },

  /** Named GSAP eases. `outExpo` is the house curve: quick start, long settle. */
  ease: {
    out: 'power3.out',
    outExpo: 'expo.out',
    inOut: 'power2.inOut',
    soft: 'power1.out',
  },

  /** How far a revealed element travels, in pixels. */
  distance: {
    sm: 16,
    md: 32,
    lg: 56,
  },

  /**
   * Animation intensity for this deployment.
   *
   * `full`    — every reveal and the hero timeline
   * `subtle`  — reveals only, no parallax, shorter durations
   * `off`     — no motion; everything renders in its final state
   *
   * A client can lower this without touching a component.
   */
  intensity: 'full' as 'full' | 'subtle' | 'off',
} as const;

export type MotionIntensity = typeof motion.intensity;
