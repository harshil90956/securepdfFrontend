import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import * as pdfjsLib from 'pdfjs-dist';

pdfjsLib.GlobalWorkerOptions.workerSrc = `//cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.js`;

export interface DetectedRegion {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

type ObjectBoxMm = {
  xMm: number;
  yMm: number;
  widthMm: number;
  heightMm: number;
};

export const DocumentPreview: React.FC<{
  docType: 'pdf' | 'svg';
  pdfUrl?: string | null;
  svgContent?: string | null;
  onPdfRendered?: (canvas: HTMLCanvasElement) => void;
  onRegionDetected?: (regions: DetectedRegion[]) => void;
  onDisplayedSizeChange?: (size: { width: number; height: number }) => void;
  disableAutoCenter?: boolean;
  onRootMount?: (el: HTMLDivElement | null) => void;
  objectBoxMm?: ObjectBoxMm | null;
  seriesSlots?: { id: string; xRatio: number; yRatio: number; value?: string }[];
  selectedSeriesSlotId?: string | null;
  children?: React.ReactNode;
}> = ({
  docType,
  pdfUrl,
  svgContent,
  onPdfRendered,
  onRegionDetected,
  onDisplayedSizeChange,
  disableAutoCenter,
  onRootMount,
  objectBoxMm,
  seriesSlots,
  selectedSeriesSlotId,
  children,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const onDisplayedSizeChangeRef = useRef(onDisplayedSizeChange);

  const MM_TO_PX = 96 / 25.4;

  const canvasSizePx = useMemo(() => {
    const w = objectBoxMm?.widthMm;
    const h = objectBoxMm?.heightMm;
    const widthPx = Math.max(1, Math.round((typeof w === 'number' && Number.isFinite(w) ? w : 0) * MM_TO_PX));
    const heightPx = Math.max(1, Math.round((typeof h === 'number' && Number.isFinite(h) ? h : 0) * MM_TO_PX));
    if (widthPx > 1 && heightPx > 1) return { widthPx, heightPx };
    return { widthPx: 900, heightPx: 1200 };
  }, [MM_TO_PX, objectBoxMm?.heightMm, objectBoxMm?.widthMm]);

  const svgBytes = useMemo(() => {
    try {
      return svgContent ? new Blob([svgContent], { type: 'image/svg+xml' }).size : 0;
    } catch {
      return svgContent ? svgContent.length : 0;
    }
  }, [svgContent]);

  const isLargeSvg = svgBytes > 5 * 1024 * 1024;

  const [svgUrl, setSvgUrl] = useState<string | null>(null);
  const [bgImage, setBgImage] = useState<CanvasImageSource | null>(null);
  const [bgError, setBgError] = useState<string | null>(null);

  const series = Array.isArray(seriesSlots) ? seriesSlots : [];

  useEffect(() => {
    onDisplayedSizeChangeRef.current = onDisplayedSizeChange;
  }, [onDisplayedSizeChange]);

  useEffect(() => {
    onDisplayedSizeChangeRef.current?.({ width: canvasSizePx.widthPx, height: canvasSizePx.heightPx });
  }, [canvasSizePx.heightPx, canvasSizePx.widthPx]);

  useEffect(() => {
    if (!svgContent) {
      setSvgUrl(null);
      setBgImage(null);
      setBgError(null);
      return;
    }

    let url: string | null = null;
    try {
      url = URL.createObjectURL(new Blob([svgContent], { type: 'image/svg+xml' }));
      setSvgUrl(url);
      setBgError(null);
    } catch (e) {
      setSvgUrl(null);
      setBgImage(null);
      setBgError(e instanceof Error ? e.message : 'Failed to prepare SVG background');
    }

    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [svgContent]);

  useEffect(() => {
    if (docType !== 'svg') return;
    if (!svgUrl) {
      setBgImage(null);
      return;
    }

    let cancelled = false;

    const run = async () => {
      try {
        const img = new Image();
        img.decoding = 'async';
        img.loading = 'eager';

        await new Promise<void>((resolve, reject) => {
          img.onload = () => resolve();
          img.onerror = () => reject(new Error('Failed to load SVG background'));
          img.src = svgUrl;
        });

        if (cancelled) return;

        if (isLargeSvg) {
          const off = document.createElement('canvas');
          off.width = canvasSizePx.widthPx;
          off.height = canvasSizePx.heightPx;
          const ctx = off.getContext('2d');
          if (!ctx) throw new Error('Canvas context unavailable');
          ctx.clearRect(0, 0, off.width, off.height);
          ctx.drawImage(img, 0, 0, off.width, off.height);
          if (cancelled) return;
          setBgImage(off);
          setBgError(null);
          return;
        }

        setBgImage(img);
        setBgError(null);
      } catch (e) {
        if (!cancelled) {
          setBgImage(null);
          setBgError(e instanceof Error ? e.message : 'Failed to load background');
        }
      }
    };

    run();

    return () => {
      cancelled = true;
    };
  }, [canvasSizePx.heightPx, canvasSizePx.widthPx, docType, isLargeSvg, svgUrl]);

  useEffect(() => {
    if (docType !== 'pdf') return;
    if (!pdfUrl) {
      setBgImage(null);
      return;
    }

    let cancelled = false;

    const run = async () => {
      try {
        const loadingTask = pdfjsLib.getDocument(pdfUrl);
        const doc = await loadingTask.promise;
        const page = await doc.getPage(1);

        if (cancelled) return;

        const baseViewport = page.getViewport({ scale: 1 });
        const scale = Math.max(canvasSizePx.widthPx / baseViewport.width, canvasSizePx.heightPx / baseViewport.height);
        const viewport = page.getViewport({ scale });

        const off = document.createElement('canvas');
        off.width = Math.max(1, Math.round(viewport.width));
        off.height = Math.max(1, Math.round(viewport.height));

        const ctx = off.getContext('2d');
        if (!ctx) throw new Error('Canvas context unavailable');

        await page.render({ canvasContext: ctx, viewport }).promise;

        if (cancelled) return;
        setBgImage(off);
        setBgError(null);
      } catch (e) {
        if (!cancelled) {
          setBgImage(null);
          setBgError(e instanceof Error ? e.message : 'Failed to load background');
        }
      }
    };

    run();

    return () => {
      cancelled = true;
    };
  }, [canvasSizePx.heightPx, canvasSizePx.widthPx, docType, pdfUrl]);

  const drawOverlays = useCallback(
    (ctx: CanvasRenderingContext2D) => {
      ctx.save();
      ctx.strokeStyle = 'rgba(59,130,246,0.9)';
      ctx.lineWidth = 1;
      ctx.strokeRect(0, 0, canvasSizePx.widthPx, canvasSizePx.heightPx);
      ctx.restore();

      if (objectBoxMm) {
        for (const s of series) {
          const xPx = canvasSizePx.widthPx * Number(s.xRatio);
          const yPx = canvasSizePx.heightPx * Number(s.yRatio);

          ctx.save();
          ctx.fillStyle = 'rgb(16,185,129)';
          ctx.beginPath();
          ctx.arc(xPx, yPx, 3, 0, Math.PI * 2);
          ctx.fill();

          const label = String(s.value || '').slice(0, 16);
          if (label) {
            ctx.font = '10px Arial';
            const padX = 4;
            const padY = 2;
            const metrics = ctx.measureText(label);
            const w = metrics.width + padX * 2;
            const h = 12 + padY * 2;
            const bx = xPx + 6;
            const by = yPx + 6;

            ctx.fillStyle = 'rgba(0,0,0,0.45)';
            ctx.fillRect(bx, by, w, h);
            if (s.id && selectedSeriesSlotId && s.id === selectedSeriesSlotId) {
              ctx.strokeStyle = 'rgba(16,185,129,0.9)';
              ctx.lineWidth = 1;
              ctx.strokeRect(bx, by, w, h);
            }

            ctx.fillStyle = 'rgb(209,250,229)';
            ctx.fillText(label, bx + padX, by + 12);
          }
          ctx.restore();
        }
      }
    },
    [canvasSizePx.heightPx, canvasSizePx.widthPx, objectBoxMm, selectedSeriesSlotId, series]
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    if (canvas.width !== canvasSizePx.widthPx) canvas.width = canvasSizePx.widthPx;
    if (canvas.height !== canvasSizePx.heightPx) canvas.height = canvasSizePx.heightPx;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (bgImage) {
      ctx.save();
      ctx.globalAlpha = 0.25;
      ctx.drawImage(bgImage, 0, 0, canvas.width, canvas.height);
      ctx.restore();
    }

    drawOverlays(ctx);

    onPdfRendered?.(canvas);
  }, [bgImage, canvasSizePx.heightPx, canvasSizePx.widthPx, docType, drawOverlays, onPdfRendered]);

  const setRoot = (el: HTMLDivElement | null) => {
    containerRef.current = el;
    onRootMount?.(el);
  };

  return (
    <div className="flex w-full h-full bg-muted/30">
      <div className="flex-1 overflow-auto">
        <div className="flex justify-center p-6">
          <div
            ref={setRoot}
            className="preview-canvas relative shadow-[0_10px_30px_rgba(0,0,0,0.18)] ring-1 ring-black/10 text-black overflow-hidden"
            style={{
              width: `${canvasSizePx.widthPx}px`,
              height: `${canvasSizePx.heightPx}px`,
              margin: '24px auto',
            }}
          >
            <canvas ref={canvasRef} className="absolute inset-0 block" />
            {bgError ? (
              <div className="absolute inset-0 flex items-center justify-center text-sm text-destructive px-6 text-center pointer-events-none">
                {bgError}
              </div>
            ) : null}
            {children}
          </div>
        </div>
      </div>
    </div>
  );
};
