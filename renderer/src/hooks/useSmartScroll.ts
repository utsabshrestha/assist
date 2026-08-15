import { useRef, useState, useEffect, useCallback, type RefObject } from 'react';

/** Distance from the bottom (px) within which the panel is considered "at the bottom". */
const AT_BOTTOM_THRESHOLD = 80;

interface UseSmartScrollResult {
  /** Attach to the scrollable container element. */
  scrollRef: RefObject<HTMLDivElement>;
  /** Invisible sentinel placed at the very end of the content. */
  bottomRef: RefObject<HTMLDivElement>;
  /** True when the user is at (or near) the bottom — auto-scroll is active. */
  isAtBottom: boolean;
  /** Imperatively jump to the bottom and re-enable auto-scroll. */
  scrollToBottom: () => void;
}

/**
 * Smart auto-scroll hook.
 *
 * - While the user is near the bottom the panel auto-scrolls on every `deps` change.
 * - When the user scrolls up the view freezes and `isAtBottom` becomes `false`.
 * - `scrollToBottom()` jumps back and re-enables auto-scroll.
 * - The panel re-pins automatically when the user scrolls back down manually.
 */
export function useSmartScroll(deps: unknown[]): UseSmartScrollResult {
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Track whether auto-scroll is currently pinned.
  // Start as `true` so the very first render scrolls to the bottom.
  const [isAtBottom, setIsAtBottom] = useState(true);

  // Derive "at bottom" state from the scroll container.
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setIsAtBottom(distFromBottom < AT_BOTTOM_THRESHOLD);
  }, []);

  // Attach / detach scroll listener.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.addEventListener('scroll', handleScroll, { passive: true });
    // Run once on mount so initial state is correct.
    handleScroll();
    return () => el.removeEventListener('scroll', handleScroll);
  }, [handleScroll]);

  // Auto-scroll when deps change — only if currently pinned at the bottom.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (isAtBottom) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, deps); // intentionally spread deps here

  const scrollToBottom = useCallback(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    // Optimistically set true; the scroll listener will confirm once it fires.
    setIsAtBottom(true);
  }, []);

  return { scrollRef, bottomRef, isAtBottom, scrollToBottom };
}
