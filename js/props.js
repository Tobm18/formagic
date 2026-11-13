// Barre de propriétés contextuelle (outil courant ou annotation sélectionnée)
import { S, on } from './state.js';
import { $, h } from './util.js';
import { FONTS } from './geom.js';
import * as A from './annotations.js';

const PALETTE = ['#000000', '#e5484d', '#f59e0b', '#1f9d55', '#1a56db', '#8b5cf6', '#6b7280', '#ffffff'];
const HL_PALETTE = ['#ffe14d', '#a3e635', '#5eead4', '#7dd3fc', '#f9a8d4', '#fdba74'];

export function initProps() {
  on('selection', render);
  on('tool', render);
}

export function render() {
  const el = $('#props');
  el.innerHTML = '';
  const sel = A.selectedAnnots();
  let keys, values, isHl = false;
  if (sel.length) {
    const sets = sel.map((a) => A.TYPE_PROPS[A.propsKeyFor(null, a)] || []);
    keys = sets.reduce((acc, s) => acc.filter((k) => s.includes(k)));
    values = sel[0];
    isHl = sel.every((a) => a.type === 'markup' && a.mode === 'highlight');
  } else {
    const key = A.propsKeyFor(S.tool);
    keys = A.TYPE_PROPS[key] || [];
    values = A.toolProps[key] || {};
    isHl = key === 'highlight';
  }
  const apply = (p, final = true) => A.applyProps(p, final);

  for (const k of keys) {
    if (k === 'font') {
      const s = h('select', { title: 'Police' }, ...Object.entries(FONTS).map(([id, f]) => h('option', { value: id, selected: id === values.font }, f.label)));
      s.onchange = () => apply({ font: s.value });
      el.append(s);
    } else if (k === 'size') {
      const n = h('input', { type: 'number', min: 3, max: 400, step: 1, value: Math.round((values.size || (values.w ?? 14)) * 10) / 10, title: 'Taille (pt)' });
      n.oninput = () => { const v = parseFloat(n.value); if (v > 0) apply({ size: v }, false); };
      n.onchange = () => { const v = parseFloat(n.value); if (v > 0) apply({ size: v }); };
      el.append(h('span', { class: 'field' }, h('span', { class: 'lbl' }, 'Taille'), n));
    } else if (k === 'bold' || k === 'italic') {
      if (k === 'italic') continue;
      const seg = h('span', { class: 'seg' });
      for (const [p, ic, t] of [['bold', 'bold', 'Gras (Ctrl+B)'], ['italic', 'italic', 'Italique (Ctrl+I)']]) {
        const b = h('button', { 'data-icon': ic, title: t, class: values[p] ? 'on' : '', type: 'button' });
        b.onclick = () => { const v = !b.classList.contains('on'); b.classList.toggle('on', v); apply({ [p]: v }); };
        seg.append(b);
      }
      el.append(seg);
    } else if (k === 'align') {
      const seg = h('span', { class: 'seg' });
      for (const [v, ic] of [['left', 'alignleft'], ['center', 'aligncenter'], ['right', 'alignright']]) {
        const b = h('button', { 'data-icon': ic, title: { left: 'Gauche', center: 'Centré', right: 'Droite' }[v], class: (values.align || 'left') === v ? 'on' : '', type: 'button' });
        b.onclick = () => { seg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); apply({ align: v }); };
        seg.append(b);
      }
      el.append(seg);
    } else if (k === 'color') {
      el.append(colorField(isHl ? HL_PALETTE : PALETTE, values.color, (c, f) => apply({ color: c }, f), false, 'Couleur'));
    } else if (k === 'bg' || k === 'fill') {
      el.append(h('span', { class: 'lbl' }, k === 'bg' ? 'Fond' : 'Remplissage'));
      el.append(colorField(['#ffffff', '#fff3b0', '#dbeafe', '#fde2e2', '#000000'], values[k], (c, f) => apply({ [k]: c }, f), true, k === 'bg' ? 'Fond' : 'Remplissage'));
    } else if (k === 'width') {
      const r = h('input', { type: 'range', min: 0.5, max: 24, step: 0.5, value: values.width ?? 2, title: 'Épaisseur' });
      const lbl = h('span', { class: 'lbl', style: { minWidth: '34px' } }, `${values.width ?? 2} pt`);
      r.oninput = () => { lbl.textContent = `${r.value} pt`; apply({ width: +r.value }, false); };
      r.onchange = () => apply({ width: +r.value });
      el.append(h('span', { class: 'field' }, h('span', { class: 'lbl' }, 'Trait'), r, lbl));
    } else if (k === 'opacity') {
      const r = h('input', { type: 'range', min: 0.1, max: 1, step: 0.05, value: values.opacity ?? 1, title: 'Opacité' });
      const lbl = h('span', { class: 'lbl', style: { minWidth: '34px' } }, `${Math.round((values.opacity ?? 1) * 100)} %`);
      r.oninput = () => { lbl.textContent = `${Math.round(r.value * 100)} %`; apply({ opacity: +r.value }, false); };
      r.onchange = () => apply({ opacity: +r.value });
      el.append(h('span', { class: 'field' }, h('span', { class: 'lbl' }, 'Opacité'), r, lbl));
    }
  }

  if (sel.length) {
    if (keys.length) el.append(h('span', { class: 'sep' }));
    el.append(
      h('button', { class: 'ib sm', 'data-icon': 'copy', title: 'Dupliquer (Ctrl+D)', onclick: () => A.duplicateSelection() }),
      h('button', { class: 'ib sm', 'data-icon': 'front', title: 'Premier plan', onclick: () => A.reorderSelection(true) }),
      h('button', { class: 'ib sm', 'data-icon': 'back', title: 'Arrière-plan', onclick: () => A.reorderSelection(false) }),
      h('button', { class: 'ib sm', 'data-icon': 'trash', title: 'Supprimer (Suppr)', onclick: () => A.deleteSelection() }),
    );
  } else if (!keys.length) {
    const hint = HINTS[S.tool];
    if (hint) el.append(h('span', { class: 'lbl' }, hint));
  }
}

const HINTS = {
  select: 'Cliquez une annotation pour la modifier · double-clic pour éditer un texte',
  pan: 'Glissez pour faire défiler',
  eraser: 'Passez sur une annotation pour l\'effacer',
  redact: 'Le contenu sous le rectangle sera supprimé définitivement à l\'enregistrement',
  link: 'Tracez la zone cliquable',
  crop: 'Tracez la zone à conserver',
  stamp: 'Choisissez un tampon puis cliquez sur la page',
};

function colorField(palette, value, onPick, allowNone, title) {
  const wrap = h('span', { class: 'swatches', title });
  const mark = (v) => wrap.querySelectorAll('.sw').forEach((s) => s.classList.toggle('on', (s.dataset.c || null) === (v || null)));
  if (allowNone) {
    const n = h('button', { class: 'sw none', 'data-c': '', title: 'Aucun', type: 'button' });
    n.onclick = () => { mark(null); onPick(null, true); };
    wrap.append(n);
  }
  for (const c of palette) {
    const b = h('button', { class: 'sw', style: { background: c }, 'data-c': c, title: c, type: 'button' });
    b.onclick = () => { mark(c); custom.value = c; onPick(c, true); };
    wrap.append(b);
  }
  const custom = h('input', { type: 'color', class: 'sw-custom', value: value || '#000000', title: 'Autre couleur' });
  custom.oninput = () => { mark(custom.value); onPick(custom.value, false); };
  custom.onchange = () => onPick(custom.value, true);
  wrap.append(custom);
  mark(value || null);
  return wrap;
}
