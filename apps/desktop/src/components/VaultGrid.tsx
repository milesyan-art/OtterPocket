import { useEffect, useRef, useState } from 'react';
import { ITEM_KIND_LABELS, formatTimestamp, siteName } from '@otterpocket/shared';
import { assetUrl, type BoardItem } from '../api';
import { bookmarkPictureHeight, isBookmark, isSmallPicture, isTyping, itemSize } from '../board/Board';
import { Favicon } from './Favicon';

interface Props {
  items: BoardItem[];
  selectedId: string | null;
  /** A newly saved item to scroll to and select, once it is in the list. */
  reveal: string | null;
  onRevealed(itemId: string): void;
  onSelect(itemId: string | null): void;
  onOpenSource(itemId: string): void;
}

/** The Vault reads like a shelf of cards: the image, why you kept it, and where it came from. */
export function VaultGrid({ items, selectedId, reveal, onRevealed, onSelect, onOpenSource }: Props) {
  const gridRef = useRef<HTMLDivElement>(null);
  const [arrived, setArrived] = useState<string | null>(null);
  const newestFirst = [...items].sort((a, b) => b.placement.addedAt - a.placement.addedAt);

  useEffect(() => {
    if (!reveal) return;
    const card = gridRef.current?.querySelector(`[data-item-id="${CSS.escape(reveal)}"]`);
    if (!card) return; // not loaded yet
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    card.scrollIntoView({ block: 'nearest', behavior: still ? 'auto' : 'smooth' });
    if (!isTyping(document.activeElement)) onSelect(reveal);
    setArrived(reveal);
    onRevealed(reveal);
  }, [reveal, items]);

  return (
    <div className="vault" onClick={() => onSelect(null)}>
      <div className="vault-grid" ref={gridRef}>
        {newestFirst.map(({ item }) => {
          const bookmark = isBookmark(item);
          // A saved page always shows its title, under its picture cut to the shape it has on a board.
          const heading = bookmark ? item.title || item.source.pageTitle || siteName(item.source.pageUrl) : item.title;
          const shape = !(item.width && item.height)
            ? undefined
            : bookmark
              ? `${itemSize(item).w} / ${bookmarkPictureHeight(item.width, item.height)}`
              : `${item.width} / ${item.height}`;
          const small = bookmark && item.width != null && isSmallPicture(item.width);
          return (
            <article
              key={item.id}
              data-item-id={item.id}
              className={`card${item.id === selectedId ? ' selected' : ''}${item.id === arrived ? ' arrived' : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                onSelect(item.id);
              }}
              onDoubleClick={() => onOpenSource(item.id)}
              onAnimationEnd={(e) => e.animationName === 'arrive' && setArrived(null)}
            >
              {item.asset ? (
                <img
                  className={`card-image${bookmark ? ' bookmark' : ''}${small ? ' small' : ''}`}
                  src={assetUrl(item.asset)}
                  alt={item.title ?? ''}
                  loading="lazy"
                  style={shape ? { aspectRatio: shape } : undefined}
                />
              ) : (
                <div className="card-cover">
                  <h3>{item.title || item.source.pageTitle || siteName(item.source.pageUrl)}</h3>
                </div>
              )}
              <div className="card-body">
                <div className="card-meta">
                  <span className={`kind kind-${item.kind}`}>{ITEM_KIND_LABELS[item.kind]}</span>
                  {item.source.videoTime != null && <span>▶ {formatTimestamp(item.source.videoTime)}</span>}
                </div>
                {item.asset && heading && <h3 className="card-title">{heading}</h3>}
                {item.why && <p className="card-why">{item.why}</p>}
                <button
                  className="card-source"
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenSource(item.id);
                  }}
                  title={item.source.pageTitle ?? item.source.pageUrl}
                >
                  <Favicon url={item.source.faviconUrl} />
                  <span>{item.source.site || siteName(item.source.pageUrl)}</span>
                  <span aria-hidden>↗</span>
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}
