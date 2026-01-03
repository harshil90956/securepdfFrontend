import React, { useEffect, useRef, useState } from 'react';

type InlineSvgViewerProps = {
  svgContent: string;
  onRegionDetected?: (regions: unknown[]) => void;
  disableAutoCenter?: boolean;
  onSvgLoaded?: (size: { width: number; height: number }) => void;
};

const RASTER_SIZE_PX = 2048;

export const InlineSvgViewer: React.FC<InlineSvgViewerProps> = ({ svgContent, onSvgLoaded }) => {
  const [pngUrl, setPngUrl] = useState<string | null>(null);
  const currentObjectUrlRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const cleanupObjectUrl = () => {
      const existing = currentObjectUrlRef.current;
      if (existing) {
        URL.revokeObjectURL(existing);
        currentObjectUrlRef.current = null;
      }
    };

    if (!svgContent) {
      cleanupObjectUrl();
      setPngUrl(null);
      return;
    }

    const run = async () => {
      cleanupObjectUrl();

      try {
        const blob = new Blob([svgContent], { type: 'image/svg+xml' });
        const objectUrl = URL.createObjectURL(blob);
        currentObjectUrlRef.current = objectUrl;

        const img = new Image();
        img.decoding = 'async';
        img.loading = 'eager';

        await new Promise<void>((resolve, reject) => {
          img.onload = () => resolve();
          img.onerror = () => reject(new Error('Failed to load SVG image'));
          img.src = objectUrl;
        });

        if (cancelled) return;

        const canvas = document.createElement('canvas');
        canvas.width = RASTER_SIZE_PX;
        canvas.height = RASTER_SIZE_PX;

        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Canvas context unavailable');

        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

        const dataUrl = canvas.toDataURL('image/png');
        if (cancelled) return;

        setPngUrl(dataUrl);
        onSvgLoaded?.({ width: canvas.width, height: canvas.height });
      } catch {
        if (!cancelled) {
          setPngUrl(null);
        }
      }
    };

    run();

    return () => {
      cancelled = true;
      cleanupObjectUrl();
    };
  }, [svgContent, onSvgLoaded]);

  if (!pngUrl) {
    return null;
  }

  return <img src={pngUrl} alt="" style={{ width: '100%', height: '100%', display: 'block' }} />;
};
