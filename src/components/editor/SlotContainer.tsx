import React, { useEffect, useRef, useState } from 'react';

interface SlotContainerProps {
  svgContent: string;
  slotWidthPx: number;
  slotHeightPx: number;
  artworkNaturalWidthPx: number;
  artworkNaturalHeightPx: number;
  slotScale: number;
  artworkOffsetX: number;
  artworkOffsetY: number;
}

export const SlotContainer: React.FC<SlotContainerProps> = ({
  svgContent,
  slotWidthPx,
  slotHeightPx,
  artworkNaturalWidthPx,
  artworkNaturalHeightPx,
  slotScale,
  artworkOffsetX,
  artworkOffsetY,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [rasterUrl, setRasterUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let url: string | null = null;
    let cancelled = false;

    const run = async () => {
      try {
        url = URL.createObjectURL(new Blob([svgContent], { type: 'image/svg+xml' }));

        const img = new Image();
        img.decoding = 'async';
        img.loading = 'eager';

        await new Promise<void>((resolve, reject) => {
          img.onload = () => resolve();
          img.onerror = () => reject(new Error('Failed to load SVG for preview'));
          img.src = url as string;
        });

        if (cancelled) return;

        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(artworkNaturalWidthPx));
        canvas.height = Math.max(1, Math.round(artworkNaturalHeightPx));
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Canvas context unavailable');

        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

        const dataUrl = canvas.toDataURL('image/png');
        if (cancelled) return;
        setRasterUrl(dataUrl);
        setError(null);
      } catch (e) {
        if (cancelled) return;
        setRasterUrl(null);
        setError(e instanceof Error ? e.message : 'Preview failed');
      }
    };

    run();

    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [artworkNaturalHeightPx, artworkNaturalWidthPx, svgContent]);

  return (
    <div
      ref={containerRef}
      className="relative"
      style={{
        width: slotWidthPx,
        height: slotHeightPx,
        overflow: 'hidden', // Clip artwork to slot bounds like backend
      }}
    >
      <div
        className="absolute"
        style={{
          left: artworkOffsetX,
          top: artworkOffsetY,
          width: artworkNaturalWidthPx,
          height: artworkNaturalHeightPx,
          transform: `scale(${slotScale})`,
          transformOrigin: 'top left',
        }}
      >
        {rasterUrl ? (
          <img src={rasterUrl} alt="Slot artwork" className="absolute inset-0 w-full h-full block" draggable={false} />
        ) : null}
        {error ? <div className="absolute inset-0 hidden">{error}</div> : null}
      </div>

      <div className="hidden" />
    </div>
  );
};
