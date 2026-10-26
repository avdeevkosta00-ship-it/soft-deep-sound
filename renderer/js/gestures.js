/**
 * «Pull down to close» for sheets on a touch screen: settings and other dialogs, the «…» menu, the sound rack,
 * Deep View. The sheet follows the finger and closes past a distance or on a quick flick; otherwise it springs back.
 * It never takes a finger that is scrolling something inside (unless that is already at its top), moving a slider
 * or seeking, and it ignores the mouse entirely.
 */
const SLIDERS = 'input, textarea, select, .eqf, .fader, .vfader, .seek, .dv-seek, .mini-range, .vol, .ly-lines, [data-noswipe]';

/** is anything between the touched element and the sheet (inclusive) scrolled away from its top? */
function scrolledAbove(node, sheet) {
  for (let el = node; el && el !== sheet.parentNode; el = el.parentNode) if (el.nodeType === 1 && el.scrollTop > 0) return true;
  return false;
}

/**
 * @param sheet   the element that moves with the finger
 * @param onClose called with the distance pulled when the sheet should close; the sheet is left where the finger let go
 * @param canStart optional (event) => false to refuse a touch
 */
export function swipeToClose(sheet, { onClose, canStart = () => true, threshold = 110 }) {
  let tr = null, lastScroll = 0;
  const move = (dy) => { sheet.style.transform = `translateY(${dy}px)`; };
  // scrolling back to the top (often in a few flicks, the last ones landing on the top) must not end in a close:
  // flicks that follow each other count as one scroll, and only a pull after a pause at the top closes the sheet
  sheet.addEventListener('scroll', () => { lastScroll = performance.now(); }, { capture: true, passive: true });
  sheet.addEventListener('touchstart', (e) => {
    tr = null;
    if (e.touches.length !== 1 || e.target.closest(SLIDERS) || !canStart(e)) return;
    if (performance.now() - lastScroll < 700) { lastScroll = performance.now(); return; } // still in the same run of flicks
    const t = e.touches[0];
    tr = { x: t.clientX, y: t.clientY, t: performance.now(), dy: 0, on: false, target: e.target };
  }, { passive: true });
  sheet.addEventListener('touchmove', (e) => {
    if (!tr) return;
    const t = e.touches[0], dx = t.clientX - tr.x, d = t.clientY - tr.y;
    if (!tr.on) {
      if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(d)) { tr = null; return; } // a sideways swipe (a strip of chips)
      if (d < -8) { tr = null; return; }                                           // scrolling up: not ours
      if (d < 10) return;
      if (scrolledAbove(tr.target, sheet)) { tr = null; return; }               // the content scrolls back first
      tr.on = true; tr.y = t.clientY; tr.t = performance.now();
      sheet.style.transition = 'none';
    }
    e.preventDefault();
    tr.dy = Math.max(0, t.clientY - tr.y);
    move(tr.dy);
  }, { passive: false });
  const end = () => {
    if (!tr || !tr.on) { tr = null; return; }
    const { dy, t } = tr; tr = null;
    const speed = dy / Math.max(1, performance.now() - t); // px per ms
    sheet.style.transition = '';
    if (dy > threshold || (speed > .55 && dy > 30)) onClose(dy);
    else {
      sheet.animate([{ transform: `translateY(${dy}px)` }, { transform: 'translateY(0)' }], { duration: 260, easing: 'cubic-bezier(.2,.9,.3,1.2)' });
      sheet.style.transform = '';
    }
  };
  sheet.addEventListener('touchend', end);
  sheet.addEventListener('touchcancel', end);
}

/** slide a pulled sheet the rest of the way down, then let its own close() finish; clears the inline transform afterwards */
export function slideAway(sheet, dy, then) {
  const a = sheet.animate([{ transform: `translateY(${dy}px)` }, { transform: 'translateY(105%)' }], { duration: 200, easing: 'cubic-bezier(.4,0,1,1)', fill: 'forwards' });
  a.finished.catch(() => {}).then(() => {
    then();
    // once it is out of sight, hand the position back to the stylesheet (the next opening starts clean)
    setTimeout(() => { a.cancel(); sheet.style.transform = ''; }, 460);
  });
}
