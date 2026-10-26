/**
 * "Track in hand" drag: the row lifts into a floating card that follows the cursor with a
 * little inertia and tilt; drop targets lean in; on drop the card is sucked into the target,
 * otherwise it flies back home.
 */
import { h, clamp } from './ui.js';

const TARGETS = '.pl-item, .nav-item[data-view="queue"], .np-next';

export function attachTrackDrag(wrap, { idsFor, describe, hintFor, onDrop }) {
  wrap.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    // a finger on a touch screen scrolls the list; dragging tracks is for the mouse
    if (e.pointerType === 'touch') return;
    const row = e.target.closest('.row');
    if (!row || e.target.closest('button, .play-mini')) return;
    const sx = e.clientX, sy = e.clientY;
    let d = null;
    const move = (ev) => {
      if (!d) { if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 7) return; d = begin(row, ev); }
      d.update(ev);
    };
    const up = (ev) => {
      removeEventListener('pointermove', move); removeEventListener('pointerup', up); removeEventListener('keydown', esc);
      removeEventListener('pointercancel', cancel);
      if (d) {
        d.finish(ev, false);
        // swallow only the click that this very drag produces (wherever it lands), then stop
        const block = (c) => { c.stopPropagation(); c.preventDefault(); };
        addEventListener('click', block, { capture: true, once: true });
        setTimeout(() => removeEventListener('click', block, { capture: true }), 0);
      }
    };
    const stop = (ev) => {
      removeEventListener('pointermove', move); removeEventListener('pointerup', up); removeEventListener('keydown', esc); removeEventListener('pointercancel', cancel);
      if (d) d.finish(ev, true); d = null;
    };
    const esc = (ev) => { if (ev.key === 'Escape' && d) stop(ev); };
    const cancel = (ev) => stop(ev);
    addEventListener('pointermove', move); addEventListener('pointerup', up); addEventListener('keydown', esc); addEventListener('pointercancel', cancel);
  });

  function begin(row, ev) {
    const ids = idsFor(row);
    const info = describe(ids);
    const hint = h('div', { class: 'hint' });
    const card = h('div', { class: 'drag-card' + (ids.length > 1 ? ' stack' : '') },
      h('div', { class: 'thumb', style: { background: info.art } }),
      h('div', { style: { minWidth: 0 } }, h('div', { class: 't' }, info.title), h('div', { class: 'a' }, info.artist)),
      ids.length > 1 ? h('div', { class: 'cnt' }, ids.length) : null, hint);
    document.body.append(card);
    const thumb = row.querySelector('.thumb').getBoundingClientRect();
    const home = { x: thumb.left - 8, y: thumb.top - 8 };
    const off = { x: clamp(ev.clientX - home.x, 24, 90), y: clamp(ev.clientY - home.y, 18, 42) };
    const pos = { ...home }, tgt = { ...home };
    let rot = 0, scale = 1, over = null, alive = true, settle = null;
    const lifted = [...wrap.querySelectorAll('.row')].filter((r) => ids.includes(r.dataset.id));
    lifted.forEach((r) => r.classList.add('lifted'));
    document.body.classList.add('track-dragging');
    card.style.transform = `translate(${pos.x}px, ${pos.y}px)`;

    const tick = () => {
      if (!alive) return;
      const px = pos.x;
      pos.x += (tgt.x - pos.x) * .3; pos.y += (tgt.y - pos.y) * .3;
      rot += (clamp((pos.x - px) * .9, -16, 16) - rot) * .2;          // tilt with horizontal speed, like a held card
      scale += ((over ? .88 : 1.06) - scale) * .2;                       // lifts, then "leans" into a target
      card.style.transform = `translate(${pos.x}px, ${pos.y}px) rotate(${rot}deg) scale(${scale})`;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);

    return {
      update(e) {
        tgt.x = e.clientX - off.x; tgt.y = e.clientY - off.y;
        const el = document.elementFromPoint(e.clientX, e.clientY);
        const t = el && el.closest(TARGETS);
        if (t !== over) {
          over && over.classList.remove('drop-hover');
          over = t;
          if (over) { over.classList.add('drop-hover'); hint.textContent = hintFor(over); }
          card.classList.toggle('over', !!over);
        }
      },
      finish(e, cancel) {
        alive = false;
        document.body.classList.remove('track-dragging');
        over && over.classList.remove('drop-hover');
        const from = `translate(${pos.x}px, ${pos.y}px) rotate(${rot}deg) scale(${scale})`;
        if (over && !cancel) {
          const dest = (over.querySelector('.pl-art, svg, .np-next-head') || over).getBoundingClientRect();
          const to = `translate(${dest.left + dest.width / 2 - 30}px, ${dest.top + dest.height / 2 - 30}px) rotate(0deg) scale(.16)`;
          const target = over;
          card.animate([{ transform: from, opacity: 1 }, { transform: to, opacity: .2 }], { duration: 380, easing: 'cubic-bezier(.55,0,.7,.2)' })
            .finished.then(() => { card.remove(); lifted.forEach((r) => r.classList.remove('lifted')); onDrop(target, ids); });
        } else {
          card.animate([{ transform: from }, { transform: `translate(${home.x}px, ${home.y}px) rotate(0deg) scale(1)` }], { duration: 420, easing: 'cubic-bezier(.22,.9,.26,1)' })
            .finished.then(() => { card.remove(); lifted.forEach((r) => r.classList.remove('lifted')); });
        }
      }
    };
  }
}
