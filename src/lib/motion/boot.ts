/**
 * Motion bootstrap.
 *
 * The engine is a single module that pulls in GSAP and Anime.js — around 140 kB
 * of JavaScript. Most organizer screens have nothing to animate: a refund table,
 * a settings form and the scanner should not pay for a timeline library.
 *
 * This loader checks whether the page actually contains something the engine
 * knows how to animate, and imports it only if so. Pages with no motion
 * attributes ship no animation code at all.
 *
 * The check runs after the DOM is parsed (Astro emits a deferred module), so the
 * elements are already present. The hero's hidden initial state is set by an
 * inline bootstrap in `<head>` and is unaffected: on pages that do have a hero,
 * the engine loads and reveals it as before.
 */
const MOTION_SELECTOR = [
  '[data-hero]',
  '[data-reveal]',
  '[data-stagger]',
  '[data-parallax]',
  '[data-counter]',
].join(',');

if (document.querySelector(MOTION_SELECTOR)) {
  void import('./engine');
}
