// Shared Framer Motion vocabulary for BrowserSnip "Studio" design system (v3).
// Import these instead of inventing one-off variants. MotionConfig reducedMotion
// at app root handles prefers-reduced-motion globally.
import type { Variants, Transition } from 'framer-motion';

/** Signature easing: expressive out */
export const EASE_OUT = [0.16, 1, 0.3, 1] as const;

export const springSoft: Transition = { type: 'spring', stiffness: 260, damping: 26 };
export const easeOut: Transition = { duration: 0.35, ease: EASE_OUT };

/** Standard entrance: rise + fade. Pair with staggerChildren on the parent. */
export const fadeUp: Variants = {
  hidden: { opacity: 0, y: 16 },
  visible: { opacity: 1, y: 0, transition: easeOut },
};

/** Container that staggers fadeUp/scaleIn children (~50ms apart). */
export const staggerParent: Variants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.05, delayChildren: 0.05 } },
};

/** Subtle pop for badges, chips, icon tiles. */
export const scaleIn: Variants = {
  hidden: { opacity: 0, scale: 0.96 },
  visible: { opacity: 1, scale: 1, transition: easeOut },
};

/** Slide from left — sidebar rows, back links. */
export const slideLeft: Variants = {
  hidden: { opacity: 0, x: -12 },
  visible: { opacity: 1, x: 0, transition: easeOut },
};

/** whileInView preset for cards/sections: play once when scrolled into view. */
export const viewportOnce = { once: true, margin: '-40px' } as const;

/** Gentle infinite float for idle drop-zone icons (±4px, 3s). */
export const floatLoop = {
  animate: { y: [0, -4, 0] },
  transition: { duration: 3, repeat: Infinity, ease: 'easeInOut' as const },
};

/** Card hover: 2px lift. */
export const cardHover = { y: -2 } as const;

/** Press feedback. */
export const tapDown = { scale: 0.97 } as const;
