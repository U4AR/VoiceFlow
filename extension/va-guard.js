// Voice Agent (added): keeps web pages from interfering with the task popup. It loads before the page's own scripts,
// so its listeners run first. For key and press events aimed at the popup (seen by the page as its
// <voice-agent-tasks> element), it stops the page's listeners from seeing them: sites such as Discord or Gmail
// otherwise move focus to their own box when you type, or swallow the press. The browser's default action (typing a
// letter, focusing the box) still happens, and the popup's own click handlers are unaffected.
(() => {
  if (window.top !== window || globalThis.__vaGuard) return;
  globalThis.__vaGuard = true;
  const ours = (e) => e.target && e.target.localName === 'voice-agent-tasks';
  for (const type of ['keydown', 'keyup', 'keypress', 'pointerdown', 'pointerup', 'mousedown', 'mouseup', 'touchstart', 'touchend', 'focusin', 'focusout']) {
    window.addEventListener(
      type,
      (e) => {
        if (!ours(e)) return;
        e.stopImmediatePropagation();
        // The popup still needs Escape and Enter; it listens through this hook.
        if (type === 'keydown' && typeof globalThis.__vaKey === 'function') globalThis.__vaKey(e);
      },
      true,
    );
  }
})();
