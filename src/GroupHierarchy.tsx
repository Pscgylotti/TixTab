import { useState } from 'react';
import { Layers } from 'lucide-react';
import type { PlacedImage } from './model';
import { isPicture } from './model';
import { t } from './i18n';

function Branch({ image }: { image: PlacedImage }) {
  const [open, setOpen] = useState(false);
  if (!image.group) {
    const label =
      image.kind === 'formula'
        ? t('公式')
        : image.kind === 'text'
          ? t('文本框')
          : isPicture(image)
            ? t('图片')
            : t('草图');
    const description = image.latex || image.textBox?.content;
    return (
      <li className="group-hierarchy-leaf">
        {label}
        {description ? ` · ${description.slice(0, 60)}` : ''}
      </li>
    );
  }
  return (
    <li>
      <details
        onToggle={(e) => {
          if (e.target === e.currentTarget) setOpen(e.currentTarget.open);
        }}
      >
        <summary>
          {t('组合')} · {image.group.objects.length}
        </summary>
        {open && (
          <ul>
            {image.group.objects.map((child, n) => (
              <Branch key={`${child.id}:${n}`} image={child} />
            ))}
          </ul>
        )}
      </details>
    </li>
  );
}
/** Mount each branch only when expanded; collapsed groups add no child DOM work. */
export default function GroupHierarchy({ image }: { image: PlacedImage }) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="group-hierarchy"
      onToggle={(e) => {
        if (e.target === e.currentTarget) setOpen(e.currentTarget.open);
      }}
    >
      <summary title={t('组合层级')}>
        <Layers size={15} aria-hidden="true" />
        {t('组合层级')}
      </summary>
      {open && (
        <div className="group-hierarchy-menu" aria-label={t('组合层级')}>
          <p>{t('解除组合只展开当前一层，内部组合会保留。')}</p>
          <ul>
            {image.group?.objects.map((child, n) => (
              <Branch key={`${child.id}:${n}`} image={child} />
            ))}
          </ul>
        </div>
      )}
    </details>
  );
}
