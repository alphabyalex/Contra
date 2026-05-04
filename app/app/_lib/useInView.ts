'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Returns [ref, inView]. `inView` flips to true the first time the
 * referenced element intersects the viewport, then stays true (one-shot
 * — we don't re-trigger on scroll-out so animations don't re-replay).
 */
export function useInView<T extends HTMLElement>(threshold = 0.2): [React.RefObject<T>, boolean] {
  const ref = useRef<T>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setInView(true);
      return;
    }
    const obs = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setInView(true);
          obs.disconnect();
        }
      },
      { threshold },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [threshold]);

  return [ref, inView];
}
