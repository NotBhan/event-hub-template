/**
 * Motion engine.
 *
 * One client module owns every animation on the site. Pages opt in with data
 * attributes rather than importing GSAP themselves, which keeps timelines out of
 * components and makes cleanup a single concern instead of one per page.
 *
 * ## Lifecycle
 *
 * Astro fires `astro:page-load` on first load and again after any client-side
 * navigation. Initialisation is idempotent: each pass reverts the previous
 * `gsap.context()` first, so ScrollTriggers and timelines cannot accumulate and
 * duplicate across navigations.
 *
 * ## Reduced motion
 *
 * The engine checks `prefers-reduced-motion` before doing anything. When motion
 * is reduced or disabled, it removes the `data-motion` marker from the document
 * so the stylesheet's hidden initial states stop applying — the content is simply
 * there. Animation is never required for content to be visible or usable.
 *
 * ## Attributes
 *
 *   data-hero                 hero timeline root
 *   data-hero-item            child of the hero, revealed in order
 *   data-reveal               scroll reveal (default: fade + rise)
 *   data-reveal="fade|up|left|right|scale"
 *   data-reveal-delay="0.2"   extra delay in seconds
 *   data-stagger               children of this element reveal in sequence
 *   data-stagger="0.12"        custom interval
 *   data-parallax="0.12"      subtle scroll-linked image drift
 *   data-counter="2046"        count-up number; text content is the fallback
 */
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { animate } from 'animejs';
import { motion } from './tokens';

gsap.registerPlugin(ScrollTrigger);

type RevealVariant = 'fade' | 'up' | 'left' | 'right' | 'scale';

let context: gsap.Context | null = null;
let initialised = false;

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function isEnabled(): boolean {
  return (
    motion.intensity !== 'off' &&
    !prefersReducedMotion() &&
    document.documentElement.dataset.motion === 'on'
  );
}

/** Elements hidden by CSS until the engine adopts them. */
function releaseHiddenState(): void {
  delete document.documentElement.dataset.motion;
}

function revealState(variant: RevealVariant): gsap.TweenVars {
  const distance = motion.distance;

  /**
   * Opacity rather than `autoAlpha`: `visibility: hidden` would drop the element
   * out of the accessibility tree until its animation runs, so a screen-reader
   * user would find the page mysteriously empty. Opacity keeps it announced while
   * still invisible on screen.
   */
  switch (variant) {
    case 'fade':
      return { opacity: 0 };
    case 'left':
      return { opacity: 0, x: -distance.lg };
    case 'right':
      return { opacity: 0, x: distance.lg };
    case 'scale':
      return { opacity: 0, scale: 0.94, y: distance.sm };
    case 'up':
    default:
      return { opacity: 0, y: distance.md };
  }
}

/**
 * Hero: masked line reveal, then supporting elements.
 *
 * Positions are explicit rather than relative (`'>'`, `'-=0.3'`). A hero
 * entrance has to finish quickly — the visitor is waiting to read — so the lines
 * cascade on a small fixed offset and the whole thing is done in well under two
 * seconds, regardless of how many lines an author adds.
 */
function buildHero(root: Element): void {
  const items = gsap.utils.toArray<HTMLElement>('[data-hero-item]', root);
  if (items.length === 0) return;

  const timeline = gsap.timeline({
    defaults: { ease: motion.ease.outExpo },
  });

  let maskIndex = 0;
  let supportIndex = 0;

  for (const item of items) {
    const masked = item.querySelector<HTMLElement>('[data-hero-line]');
    const variant = (item.dataset.heroItem || 'up') as RevealVariant | 'mask';

    if (variant === 'mask' && masked) {
      /**
       * The wrapper clips; the inner element slides up from below the clip edge.
       * The wrapper is revealed at time zero because the stylesheet holds hero
       * items invisible until the engine adopts them.
       */
      timeline.set(item, { autoAlpha: 1 }, 0);
      timeline.fromTo(
        masked,
        { yPercent: 118 },
        { yPercent: 0, duration: 0.92 },
        maskIndex * motion.stagger.tight,
      );
      maskIndex += 1;
      continue;
    }

    timeline.fromTo(
      item,
      revealState(variant === 'mask' ? 'up' : variant),
      { autoAlpha: 1, opacity: 1, x: 0, y: 0, scale: 1, duration: 0.5 },
      0.42 + supportIndex * 0.07,
    );
    supportIndex += 1;
  }
}

/** Scroll reveals, batched so one observer handles a grid of cards. */
function buildReveals(): void {
  const groups = gsap.utils.toArray<HTMLElement>('[data-stagger]');

  for (const group of groups) {
    const children = gsap.utils.toArray<HTMLElement>(':scope > *', group);
    if (children.length === 0) continue;

    const interval = Number(group.dataset.stagger) || motion.stagger.base;
    const variant = (group.dataset.staggerVariant || 'up') as RevealVariant;

    gsap.set(children, revealState(variant));

    gsap.to(children, {
      opacity: 1,
      x: 0,
      y: 0,
      scale: 1,
      duration: motion.duration.base,
      ease: motion.ease.out,
      stagger: interval,
      scrollTrigger: {
        trigger: group,
        start: 'top 85%',
        once: true,
      },
    });
  }

  const items = gsap.utils.toArray<HTMLElement>('[data-reveal]').filter(
    (element) => !element.closest('[data-stagger]'),
  );

  for (const item of items) {
    const variant = (item.dataset.reveal || 'up') as RevealVariant;
    const delay = Number(item.dataset.revealDelay) || 0;

    gsap.fromTo(item, revealState(variant), {
      opacity: 1,
      x: 0,
      y: 0,
      scale: 1,
      duration: motion.duration.base,
      ease: motion.ease.out,
      delay,
      scrollTrigger: {
        trigger: item,
        start: 'top 88%',
        once: true,
      },
    });
  }
}

/** Very light image drift; disabled when the client asks for subtle motion. */
function buildParallax(): void {
  if (motion.intensity !== 'full') return;

  const items = gsap.utils.toArray<HTMLElement>('[data-parallax]');

  for (const item of items) {
    const strength = Number(item.dataset.parallax) || 0.08;

    gsap.fromTo(
      item,
      { yPercent: -strength * 100 },
      {
        yPercent: strength * 100,
        ease: 'none',
        scrollTrigger: {
          trigger: item.closest('[data-parallax-scope]') ?? item,
          start: 'top bottom',
          end: 'bottom top',
          scrub: 0.6,
        },
      },
    );
  }
}

/**
 * Counters.
 *
 * Anime.js rather than GSAP here: this is exactly the kind of isolated numeric
 * effect it is better suited to, and it keeps the two engines on separate
 * elements rather than competing over one.
 */
function buildCounters(): void {
  const counters = gsap.utils.toArray<HTMLElement>('[data-counter]');

  for (const element of counters) {
    const target = Number(element.dataset.counter);
    if (!Number.isFinite(target)) continue;

    const prefix = element.dataset.counterPrefix ?? '';
    const suffix = element.dataset.counterSuffix ?? '';
    const decimals = Number(element.dataset.counterDecimals) || 0;

    const format = (value: number) =>
      `${prefix}${value.toLocaleString('en-IN', {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      })}${suffix}`;

    // Start from the final value so the number is correct without animation.
    element.textContent = format(target);

    const state = { value: 0 };

    ScrollTrigger.create({
      trigger: element,
      start: 'top 92%',
      once: true,
      onEnter: () => {
        animate(state, {
          value: target,
          duration: 1100,
          ease: 'outExpo',
          onUpdate: () => {
            element.textContent = format(state.value);
          },
          onComplete: () => {
            element.textContent = format(target);
          },
        });
      },
    });
  }
}

function init(): void {
  context?.revert();
  context = null;

  if (!isEnabled()) {
    releaseHiddenState();
    return;
  }

  try {
    context = gsap.context(() => {
      for (const hero of gsap.utils.toArray<HTMLElement>('[data-hero]')) buildHero(hero);
      buildReveals();
      buildParallax();
      buildCounters();
    });

    /**
     * Webfonts and images change layout after first paint, which moves every
     * trigger. Refresh once both have settled so a reveal does not fire early
     * because the element was momentarily further up the page.
     */
    void document.fonts?.ready.then(() => ScrollTrigger.refresh());
    window.addEventListener('load', () => ScrollTrigger.refresh(), { once: true });
    ScrollTrigger.refresh();
  } catch (error) {
    /**
     * If anything here fails, the page must not be left with content hidden by a
     * stylesheet rule that nothing is going to animate. Removing the marker makes
     * every hero element visible again.
     */
    console.error('[motion] initialisation failed, showing all content', error);
    releaseHiddenState();
  }
}

function destroy(): void {
  context?.revert();
  context = null;
  ScrollTrigger.getAll().forEach((trigger) => trigger.kill());
}

function start(): void {
  if (initialised) return;
  initialised = true;

  // Astro fires this on first load and after every client-side navigation.
  document.addEventListener('astro:page-load', init);

  // Tear down before the DOM is replaced so nothing leaks between pages.
  document.addEventListener('astro:before-swap', destroy);

  // Defensive: if the router event never fires (for example the script is added
  // to a page rendered without it), still initialise once.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      if (!context) init();
    });
  } else if (!context) {
    init();
  }
}

start();
